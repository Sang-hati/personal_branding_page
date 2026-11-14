// The caching engine and dashboard assembly.
//
// Every GitHub resource goes through cached(), which works like this:
//   1. Fresh copy in SQLite (younger than its TTL)  -> serve it, no network.
//   2. Otherwise ask GitHub with the saved ETag     -> 304 means "unchanged", free of rate limit.
//   3. GitHub fails (offline, rate limited)         -> serve the saved copy, flagged as stale.
// Concurrent requests for the same resource share one in-flight call.
import { addDays, addLevels, computeStreaks, toISODate } from './streaks.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MIN = 60_000;

export const DEFAULT_SETTINGS = {
  username: '',
  theme: 'auto',
  sort: 'stars',
  hideForks: true,
  hideArchived: true,
  maxRepos: 12,
  pinned: [],
  ttlProfileMin: 60,
  ttlReposMin: 30,
  ttlContribMin: 360,
};

const intIn = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const CHECKS = {
  username: (v) => typeof v === 'string' && (v === '' || LOGIN_RE.test(v)),
  theme: (v) => ['auto', 'light', 'dark'].includes(v),
  sort: (v) => ['stars', 'forks', 'updated', 'name'].includes(v),
  hideForks: (v) => typeof v === 'boolean',
  hideArchived: (v) => typeof v === 'boolean',
  maxRepos: intIn(3, 60),
  pinned: (v) => Array.isArray(v) && v.length <= 12 && v.every((n) => typeof n === 'string' && /^[\w.-]{1,100}$/.test(n)),
  ttlProfileMin: intIn(1, 1440),
  ttlReposMin: intIn(1, 1440),
  ttlContribMin: intIn(1, 1440),
};

export function createService({ store, provider, token }) {
  const inflight = new Map();

  // ---- settings -----------------------------------------------------------
  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const { key, value } of store.allSettings()) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      try {
        out[key] = JSON.parse(value);
      } catch {
        /* keep the default */
      }
    }
    const envUser = process.env.GITHUB_USERNAME?.trim();
    if (!out.username && envUser && LOGIN_RE.test(envUser)) out.username = envUser;
    return out;
  }

  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Send a JSON object of settings.');
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in CHECKS)) throw new HttpError(400, `Unknown setting: ${key}`);
      if (!CHECKS[key](value)) throw new HttpError(400, `Invalid value for ${key}`);
    }
    for (const [key, value] of Object.entries(patch)) store.putSetting(key, JSON.stringify(value));
    return getSettings();
  }

  // ---- the cache ----------------------------------------------------------
  async function cached(key, { ttl, force, load, read, write }) {
    const meta = store.getMeta(key);
    const stored = meta ? read(meta) : null;

    if (stored && !force && Date.now() - meta.fetched_at < ttl) {
      return { data: stored, status: 'hit', fetchedAt: meta.fetched_at };
    }
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      try {
        const r = await load({ etag: stored ? meta.etag : null });
        if (r.rate) store.putRate(r.rate);
        const now = Date.now();
        if (r.status === 304 && stored) {
          store.putMeta(key, { etag: meta.etag, fetchedAt: now, source: meta.source, extra: meta.extra });
          return { data: stored, status: 'revalidated', fetchedAt: now };
        }
        write(r.data);
        store.putMeta(key, {
          etag: r.etag ?? null,
          fetchedAt: now,
          source: r.data.source ?? null,
          extra: r.meta ? JSON.stringify(r.meta) : null,
        });
        return { data: read(store.getMeta(key)), status: 'fetched', fetchedAt: now };
      } catch (err) {
        if (stored) return { data: stored, status: 'stale', fetchedAt: meta.fetched_at, error: err };
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  // ---- dashboard ----------------------------------------------------------
  function buildCalendar({ days, source, coverageStart }) {
    let list;
    if (source === 'events') {
      // The events feed only lists days that had activity, so fill in the zeros.
      const counts = new Map(days.map((d) => [d.date, d.count]));
      const end = toISODate(new Date());
      list = [];
      for (let date = addDays(end, -364); date <= end; date = addDays(date, 1)) {
        list.push({ date, count: coverageStart && date < coverageStart ? null : (counts.get(date) ?? 0) });
      }
    } else {
      list = days.map((d) => ({ date: d.date, count: d.count }));
    }
    addLevels(list);
    return list;
  }

  function languageBreakdown(repos) {
    const counts = new Map();
    for (const r of repos) if (r.language && !r.isFork) counts.set(r.language, (counts.get(r.language) ?? 0) + 1);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count], i) => ({ name, count, percent: total ? Math.round((count / total) * 1000) / 10 : 0, slot: i < 7 ? i + 1 : 0 }));
  }

  async function getDashboard({ user, force = false } = {}) {
    const settings = getSettings();
    const login = (user || settings.username || '').trim();
    if (!login) return { needsSetup: true, settings };
    if (!LOGIN_RE.test(login)) throw new HttpError(400, 'That is not a valid GitHub username.');

    const k = login.toLowerCase();
    const mode = provider.contribMode(token);
    const opts = { force };

    const [profileR, reposR, contribR] = await Promise.allSettled([
      cached(`profile:${k}`, {
        ...opts,
        ttl: settings.ttlProfileMin * MIN,
        load: ({ etag }) => provider.fetchProfile(login, { token, etag }),
        read: () => store.loadProfile(k),
        write: (data) => store.saveProfile(k, data),
      }),
      cached(`repos:${k}`, {
        ...opts,
        ttl: settings.ttlReposMin * MIN,
        load: ({ etag }) => provider.fetchRepos(login, { token, etag }),
        read: () => {
          const repos = store.loadRepos(k);
          return repos.length || store.getMeta(`repos:${k}`) ? repos : null;
        },
        write: (data) => store.saveRepos(k, data),
      }),
      cached(`contrib:${k}:${mode}`, {
        ...opts,
        ttl: settings.ttlContribMin * MIN,
        load: ({ etag }) => provider.fetchContributions(login, { token, etag }),
        read: (meta) => ({
          days: store.loadContribs(k),
          source: meta.source,
          coverageStart: JSON.parse(meta.extra || '{}').coverageStart ?? null,
        }),
        write: (data) => store.saveContribs(k, data.days),
      }),
    ]);

    // Without a profile there is nothing to show, so that failure is fatal.
    if (profileR.status === 'rejected') {
      const e = profileR.reason;
      throw new HttpError(e.status === 404 ? 404 : e.rateLimited ? 429 : 502, e.message, {
        rateLimited: !!e.rateLimited,
        resetAt: e.resetAt ?? null,
      });
    }

    const errors = [];
    const part = (name, result, fallback) => {
      if (result.status === 'fulfilled') {
        if (result.value.error) {
          const e = result.value.error;
          errors.push({ part: name, message: e.message, rateLimited: !!e.rateLimited, resetAt: e.resetAt ?? null });
        }
        return result.value;
      }
      const e = result.reason;
      errors.push({ part: name, message: e.message, rateLimited: !!e.rateLimited, resetAt: e.resetAt ?? null });
      return { data: fallback, status: 'failed', fetchedAt: null };
    };

    const repoPart = part('repositories', reposR, []);
    const contribPart = part('contributions', contribR, { days: [], source: mode, coverageStart: null });

    const allRepos = repoPart.data;
    const visible = allRepos.filter((r) => !(settings.hideForks && r.isFork) && !(settings.hideArchived && r.archived));
    const languages = languageBreakdown(visible);
    const slotOf = new Map(languages.map((l) => [l.name, l.slot]));
    const pinned = new Set(settings.pinned);
    const repos = visible.map((r) => ({ ...r, langSlot: slotOf.get(r.language) ?? 0, pinned: pinned.has(r.name) }));

    const calendar = buildCalendar(contribPart.data);
    const streaks = computeStreaks(calendar);

    const info = (p) => ({ status: p.status, fetchedAt: p.fetchedAt });
    return {
      user: profileR.value.data,
      contributions: {
        days: calendar,
        source: contribPart.data.source,
        approximate: contribPart.data.source === 'events',
        trackedDays: streaks.trackedDays,
        total: streaks.total,
      },
      streaks,
      repos,
      languages,
      totals: {
        repos: visible.length,
        stars: visible.reduce((s, r) => s + r.stars, 0),
        forks: visible.reduce((s, r) => s + r.forks, 0),
      },
      settings,
      cache: {
        provider: provider.name,
        profile: info(profileR.value),
        repos: info(repoPart),
        contributions: info(contribPart),
        rate: store.getRate(),
        errors,
      },
    };
  }

  function getStatus() {
    return {
      provider: provider.name,
      hasToken: !!token,
      contributionSource: provider.contribMode(token),
      store: store.stats(),
      rate: store.getRate(),
    };
  }

  return { getSettings, updateSettings, getDashboard, getStatus, clearCache: () => store.clearCache() };
}
