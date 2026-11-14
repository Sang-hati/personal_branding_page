// GitHub REST + GraphQL client.
//
// - Profile and repositories come from the REST API.
// - The contribution calendar only exists in the GraphQL API, which needs a token.
//   Without a token we approximate it from the public events feed (last ~90 days).
// - Every request supports ETags: when nothing changed GitHub answers 304, which
//   does not count against the rate limit.

const API = 'https://api.github.com';

export class GithubError extends Error {
  constructor(message, { status = 0, rateLimited = false, resetAt = null } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
  }
}

function readRate(res) {
  const num = (name) => {
    const v = res.headers.get(name);
    return v == null ? null : Number(v);
  };
  const limit = num('x-ratelimit-limit');
  if (limit == null) return null;
  return { limit, remaining: num('x-ratelimit-remaining'), reset: num('x-ratelimit-reset') };
}

async function request(url, { token, etag, method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dev-dashboard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GithubError(`Could not reach GitHub (${err.cause?.code || err.name})`, { status: 0 });
  }

  const rate = readRate(res);
  if (res.status === 304) return { status: 304, rate, etag };

  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json()).message || '';
    } catch {
      /* body was not JSON */
    }
    const resetAt = rate?.reset ? rate.reset * 1000 : null;
    if (res.status === 404) throw new GithubError('GitHub user not found', { status: 404 });
    if (res.status === 401) throw new GithubError('GitHub rejected the token in GITHUB_TOKEN', { status: 401 });
    const rateLimited =
      res.status === 429 || (res.status === 403 && (rate?.remaining === 0 || /rate limit/i.test(message)));
    throw new GithubError(rateLimited ? 'GitHub API rate limit reached' : message || `GitHub responded with ${res.status}`, {
      status: res.status,
      rateLimited,
      resetAt,
    });
  }

  return { status: res.status, data: await res.json(), etag: res.headers.get('etag'), rate, link: res.headers.get('link') };
}

async function fetchProfile(login, { token, etag }) {
  const r = await request(`${API}/users/${encodeURIComponent(login)}`, { token, etag });
  if (r.status === 304) return r;
  const u = r.data;
  return {
    status: 200,
    etag: r.etag,
    rate: r.rate,
    data: {
      login: u.login,
      name: u.name || u.login,
      bio: u.bio,
      avatar: u.avatar_url,
      location: u.location,
      company: u.company,
      blog: u.blog,
      url: u.html_url,
      followers: u.followers,
      following: u.following,
      publicRepos: u.public_repos,
      createdAt: u.created_at,
    },
  };
}

const mapRepo = (r) => ({
  name: r.name,
  description: r.description,
  language: r.language,
  stars: r.stargazers_count,
  forks: r.forks_count,
  isFork: r.fork,
  archived: r.archived,
  url: r.html_url,
  homepage: r.homepage,
  topics: r.topics ?? [],
  pushedAt: r.pushed_at,
});

async function fetchRepos(login, { token, etag }) {
  const base = `${API}/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&per_page=100`;
  const first = await request(`${base}&page=1`, { token, etag });
  if (first.status === 304) return first;

  let items = first.data;
  let rate = first.rate;
  let link = first.link;
  for (let page = 2; page <= 3 && /rel="next"/.test(link || ''); page += 1) {
    const next = await request(`${base}&page=${page}`, { token });
    items = items.concat(next.data);
    rate = next.rate ?? rate;
    link = next.link;
  }
  return { status: 200, etag: first.etag, rate, data: items.map(mapRepo) };
}

const CALENDAR_QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;

async function fetchCalendarGraphQL(login, { token }) {
  // GraphQL has no ETag support, so this one is always a fresh request.
  const r = await request(`${API}/graphql`, { token, method: 'POST', body: { query: CALENDAR_QUERY, variables: { login } } });
  const errors = r.data.errors;
  if (errors?.length) {
    const notFound = errors.some((e) => e.type === 'NOT_FOUND');
    throw new GithubError(notFound ? 'GitHub user not found' : errors[0].message, { status: notFound ? 404 : 502 });
  }
  const calendar = r.data.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new GithubError('GitHub user not found', { status: 404 });
  const days = calendar.weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount }));
  return {
    status: 200,
    rate: r.rate,
    data: { days, source: 'graphql', coverageStart: days[0]?.date ?? null },
    meta: { coverageStart: days[0]?.date ?? null },
  };
}

// Rough "how many contributions is this event worth" for the no-token fallback.
function eventWeight(ev) {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'PushEvent':
      return p.size ?? p.commits?.length ?? 1;
    case 'PullRequestEvent':
      return p.action === 'opened' || (p.action === 'closed' && p.pull_request?.merged) ? 1 : 0;
    case 'PullRequestReviewEvent':
      return 1;
    case 'IssuesEvent':
      return p.action === 'opened' ? 1 : 0;
    case 'CreateEvent':
      return p.ref_type === 'repository' ? 1 : 0;
    default:
      return 0;
  }
}

async function fetchCalendarFromEvents(login, { token }) {
  const enc = encodeURIComponent(login);
  const counts = new Map();
  let rate = null;
  let seen = 0;
  let oldest = null;

  for (let page = 1; page <= 3; page += 1) {
    const r = await request(`${API}/users/${enc}/events/public?per_page=100&page=${page}`, { token });
    rate = r.rate ?? rate;
    seen += r.data.length;
    for (const ev of r.data) {
      const day = ev.created_at.slice(0, 10);
      if (!oldest || day < oldest) oldest = day;
      const w = eventWeight(ev);
      if (w) counts.set(day, (counts.get(day) ?? 0) + w);
    }
    if (r.data.length < 100) break;
  }

  // The feed holds at most 300 events or 90 days. If we hit the 300 cap, the oldest day
  // may be cut off, so coverage starts the day after it. Otherwise coverage is the full 90 days.
  const today = new Date().toISOString().slice(0, 10);
  const coverageStart = seen >= 300 && oldest ? addDay(oldest) : addDay(today, -89);
  const days = [...counts].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { status: 200, rate, data: { days, source: 'events', coverageStart }, meta: { coverageStart } };
}

function addDay(iso, n = 1) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const githubProvider = {
  name: 'github',
  contribMode: (token) => (token ? 'graphql' : 'events'),
  fetchProfile,
  fetchRepos,
  fetchContributions: (login, { token, etag }) =>
    token ? fetchCalendarGraphQL(login, { token, etag }) : fetchCalendarFromEvents(login, { token, etag }),
};
