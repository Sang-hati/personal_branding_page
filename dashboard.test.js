import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/db.js';
import { addLevels, computeStreaks, addDays, toISODate } from '../src/streaks.js';
import { createService } from '../src/service.js';
import { GithubError } from '../src/github.js';

const today = toISODate(new Date());
const series = (counts) => counts.map((count, i) => ({ date: addDays(today, i - counts.length + 1), count }));

test('current streak survives an empty today', () => {
  const s = computeStreaks(series([0, 2, 1, 3, 0]));
  assert.equal(s.current.length, 3);
  assert.equal(s.current.endsToday, false);
  assert.equal(s.longest.length, 3);
});

test('longest streak is found even when it is not the current one', () => {
  const s = computeStreaks(series([1, 1, 1, 1, 0, 0, 2, 1]));
  assert.equal(s.longest.length, 4);
  assert.equal(s.current.length, 2);
  assert.equal(s.activeDays, 6);
  assert.equal(s.busiest.count, 2);
});

test('days without data are ignored', () => {
  const s = computeStreaks(series([null, null, 1, 1]));
  assert.equal(s.trackedDays, 2);
  assert.equal(s.current.length, 2);
});

test('levels use quartiles of non-zero days', () => {
  const days = addLevels(series([0, 1, 2, 3, 4, 100]));
  assert.deepEqual(days.map((d) => d.level), [0, 1, 1, 2, 3, 4]);
});

function fakeProvider() {
  const calls = { profile: 0, repos: 0, contrib: 0 };
  let failing = false;
  const ok = (data, etag) => ({ status: 200, etag, data, rate: { limit: 60, remaining: 50, reset: 1 } });
  return {
    calls,
    setFailing: (v) => { failing = v; },
    provider: {
      name: 'fake',
      contribMode: () => 'events',
      async fetchProfile(login, { etag }) {
        calls.profile += 1;
        if (failing) throw new GithubError('GitHub API rate limit reached', { status: 403, rateLimited: true });
        if (etag === '"p1"') return { status: 304 };
        return ok({ login, name: 'Ada', bio: null, avatar: null, location: null, company: null, blog: null, url: 'u', followers: 1, following: 0, publicRepos: 1, createdAt: '2020-01-01T00:00:00Z' }, '"p1"');
      },
      async fetchRepos(login, { etag }) {
        calls.repos += 1;
        if (failing) throw new GithubError('GitHub API rate limit reached', { status: 403, rateLimited: true });
        if (etag === '"r1"') return { status: 304 };
        return ok([{ name: 'a', description: 'x', language: 'Go', stars: 5, forks: 1, isFork: false, archived: false, url: 'u', homepage: null, topics: [], pushedAt: '2026-01-01T00:00:00Z' }], '"r1"');
      },
      async fetchContributions() {
        calls.contrib += 1;
        if (failing) throw new GithubError('GitHub API rate limit reached', { status: 403, rateLimited: true });
        return { ...ok({ days: [{ date: today, count: 4 }], source: 'events', coverageStart: addDays(today, -89) }), meta: { coverageStart: addDays(today, -89) } };
      },
    },
  };
}

test('cache: second load is served from SQLite without calling GitHub', async () => {
  const f = fakeProvider();
  const svc = createService({ store: openStore(':memory:'), provider: f.provider, token: null });
  const first = await svc.getDashboard({ user: 'ada' });
  assert.equal(first.cache.profile.status, 'fetched');
  const second = await svc.getDashboard({ user: 'ada' });
  assert.equal(second.cache.profile.status, 'hit');
  assert.deepEqual(f.calls, { profile: 1, repos: 1, contrib: 1 });
  assert.equal(second.repos.length, 1);
  assert.equal(second.contributions.approximate, true);
  assert.equal(second.contributions.days.length, 365);
  assert.equal(second.contributions.days[0].count, null); // before the events coverage window
});

test('cache: forced refresh revalidates with the saved ETag', async () => {
  const f = fakeProvider();
  const svc = createService({ store: openStore(':memory:'), provider: f.provider, token: null });
  await svc.getDashboard({ user: 'ada' });
  const again = await svc.getDashboard({ user: 'ada', force: true });
  assert.equal(again.cache.profile.status, 'revalidated');
  assert.equal(again.cache.repos.status, 'revalidated');
  assert.equal(again.repos[0].name, 'a');
});

test('cache: when GitHub fails the saved copy is served and the error is reported', async () => {
  const f = fakeProvider();
  const svc = createService({ store: openStore(':memory:'), provider: f.provider, token: null });
  await svc.getDashboard({ user: 'ada' });
  f.setFailing(true);
  const d = await svc.getDashboard({ user: 'ada', force: true });
  assert.equal(d.cache.profile.status, 'stale');
  assert.equal(d.repos.length, 1);
  assert.ok(d.cache.errors.length >= 2);
  assert.ok(d.cache.errors.every((e) => e.rateLimited));
});

test('cold cache plus failure is an error', async () => {
  const f = fakeProvider();
  f.setFailing(true);
  const svc = createService({ store: openStore(':memory:'), provider: f.provider, token: null });
  await assert.rejects(() => svc.getDashboard({ user: 'ada' }), (e) => e.status === 429 && e.rateLimited);
});

test('settings: validated, persisted, and pinned repos are flagged', async () => {
  const f = fakeProvider();
  const svc = createService({ store: openStore(':memory:'), provider: f.provider, token: null });
  assert.throws(() => svc.updateSettings({ maxRepos: 1000 }), /Invalid value/);
  assert.throws(() => svc.updateSettings({ nope: 1 }), /Unknown setting/);
  svc.updateSettings({ username: 'ada', pinned: ['a'] });
  const d = await svc.getDashboard();
  assert.equal(d.user.login, 'ada');
  assert.equal(d.repos[0].pinned, true);
});
