// Offline provider with made-up data, used by `npm run demo`.
// It follows the same interface (and the same ETag behaviour) as the GitHub provider,
// so the caching engine runs exactly as it would against the real API.
import { addDays, toISODate } from './streaks.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function hash(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// name, description, language, stars, forks, daysSincePush, flags
const REPOS = [
  ['tidepool', 'Tide tables and swell forecasts for coastal hikers, built on open marine data.', 'TypeScript', 412, 38, 3],
  ['lantern-cli', 'A terminal client for keeping a plain-text work journal that syncs over git.', 'Rust', 287, 21, 9],
  ['pocket-ledger', 'Offline-first expense tracker for Android with receipt capture and monthly reports.', 'Kotlin', 164, 19, 14],
  ['sparrow-api', 'Small, fast REST service template with auth, rate limiting and structured logs.', 'Go', 131, 27, 6],
  ['notebook-diff', 'Readable diffs and merges for Jupyter notebooks.', 'Python', 96, 11, 31],
  ['gridwork', 'CSS grid playground that exports clean, framework-free layouts.', 'JavaScript', 74, 9, 52],
  ['stackhound', 'Finds the slowest SQL queries in a Rails or Django app from plain log files.', 'Python', 58, 6, 77],
  ['campus-bus', 'Live campus shuttle map for students, fed by a community GPS app.', 'Java', 41, 14, 120],
  ['dotfiles', 'Shell, editor and terminal config, with a one-command setup script.', 'Shell', 23, 4, 18],
  ['pixel-sorter', 'Sort the pixels of an image by brightness, hue or custom rules, in the browser.', 'TypeScript', 19, 2, 210],
  ['algo-notes', 'Worked solutions and write-ups for data structures and algorithms practice.', 'C++', 12, 3, 160],
  ['quiet-hours', 'Do-not-disturb scheduler for macOS and iOS built with SwiftUI.', 'Swift', 8, 1, 340],
  ['old-portfolio', 'The first version of this site. Kept for reference.', 'JavaScript', 3, 0, 700, 'archived'],
  ['fork-of-awesome-tool', 'Fork with a small fix for Windows path handling.', 'Go', 0, 0, 90, 'fork'],
];

function profileFor(login) {
  const display = login.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    login,
    name: display,
    bio: 'I build small tools that make everyday work calmer. This is sample data, not a real account.',
    avatar: null,
    location: 'Kolkata, India',
    company: null,
    blog: null,
    url: `https://github.com/${login}`,
    followers: 214 + (hash(login) % 90),
    following: 58,
    publicRepos: REPOS.length,
    createdAt: '2021-07-12T09:30:00Z',
  };
}

function reposFor() {
  const now = Date.now();
  return REPOS.map(([name, description, language, stars, forks, ago, flag]) => ({
    name,
    description,
    language,
    stars,
    forks,
    isFork: flag === 'fork',
    archived: flag === 'archived',
    url: `https://github.com/demo/${name}`,
    homepage: null,
    topics: [],
    pushedAt: new Date(now - ago * 86_400_000).toISOString(),
  }));
}

function calendarFor(login) {
  const rand = rng(hash(login));
  const end = toISODate(new Date());
  const start = addDays(end, -364);
  const days = [];
  for (let i = 0; i < 365; i += 1) {
    const date = addDays(start, i);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    let count = 0;
    const inLongRun = i >= 110 && i < 151; // a 41-day run well before today
    const onBreak = i >= 151 && i < 160; // a quiet stretch after it
    const inCurrentRun = i >= 365 - 17; // a 17-day run that ends today
    if (inLongRun || inCurrentRun) {
      count = 1 + Math.floor(-Math.log(1 - rand()) * (weekend ? 1.5 : 3));
    } else if (!onBreak && rand() < (weekend ? 0.3 : 0.68)) {
      count = 1 + Math.floor(-Math.log(1 - rand()) * 2.6);
    }
    if (count > 0 && rand() < 0.03) count += 12 + Math.floor(rand() * 20); // the odd big push
    days.push({ date, count: Math.min(count, 60) });
  }
  return { days, source: 'demo', coverageStart: days[0].date };
}

let served = 0;
const rate = () => ({ limit: 5000, remaining: 5000 - (served += 1), reset: Math.floor(Date.now() / 1000) + 3000 });

export const demoProvider = {
  name: 'demo',
  contribMode: () => 'demo',

  async fetchProfile(login, { etag }) {
    await wait(120);
    const tag = `"demo-profile-${login}"`;
    if (etag === tag) return { status: 304, rate: rate() };
    return { status: 200, etag: tag, rate: rate(), data: profileFor(login) };
  },

  async fetchRepos(login, { etag }) {
    await wait(180);
    const tag = `"demo-repos-${login}"`;
    if (etag === tag) return { status: 304, rate: rate() };
    return { status: 200, etag: tag, rate: rate(), data: reposFor() };
  },

  async fetchContributions(login, { etag }) {
    await wait(240);
    const tag = `"demo-calendar-${login}-${toISODate(new Date())}"`;
    if (etag === tag) return { status: 304, rate: rate() };
    const data = calendarFor(login);
    return { status: 200, etag: tag, rate: rate(), data, meta: { coverageStart: data.coverageStart } };
  },
};
