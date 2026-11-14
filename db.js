// SQLite storage for settings and the GitHub cache.
// Uses Node's built-in node:sqlite module, so there is nothing to compile or install.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL            -- JSON
  );

  -- One row per cached resource (profile, repos, contributions) per user.
  CREATE TABLE IF NOT EXISTS cache_meta (
    key        TEXT PRIMARY KEY,   -- e.g. "repos:octocat"
    etag       TEXT,               -- sent back as If-None-Match; a 304 costs no rate limit
    fetched_at INTEGER NOT NULL,   -- ms since epoch, last time GitHub confirmed this data
    source     TEXT,
    extra      TEXT                -- JSON, e.g. {"coverageStart":"2026-08-16"}
  );

  CREATE TABLE IF NOT EXISTS profiles (
    login TEXT PRIMARY KEY,
    data  TEXT NOT NULL            -- JSON
  );

  CREATE TABLE IF NOT EXISTS repos (
    login       TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    language    TEXT,
    stars       INTEGER NOT NULL DEFAULT 0,
    forks       INTEGER NOT NULL DEFAULT 0,
    is_fork     INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    url         TEXT,
    homepage    TEXT,
    topics      TEXT,              -- JSON array
    pushed_at   TEXT,
    PRIMARY KEY (login, name)
  );

  CREATE TABLE IF NOT EXISTS contributions (
    login TEXT NOT NULL,
    day   TEXT NOT NULL,           -- YYYY-MM-DD
    count INTEGER NOT NULL,
    PRIMARY KEY (login, day)
  );

  -- Last rate-limit numbers GitHub reported, shown in the page footer.
  CREATE TABLE IF NOT EXISTS rate_limit (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    lim        INTEGER,
    remaining  INTEGER,
    reset      INTEGER,            -- seconds since epoch
    updated_at INTEGER
  );
`;

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const q = {
    allSettings: db.prepare('SELECT key, value FROM settings'),
    putSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
    getMeta: db.prepare('SELECT * FROM cache_meta WHERE key = ?'),
    putMeta: db.prepare(
      `INSERT INTO cache_meta (key, etag, fetched_at, source, extra) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, fetched_at = excluded.fetched_at,
         source = excluded.source, extra = excluded.extra`
    ),
    getProfile: db.prepare('SELECT data FROM profiles WHERE login = ?'),
    putProfile: db.prepare(
      'INSERT INTO profiles (login, data) VALUES (?, ?) ON CONFLICT(login) DO UPDATE SET data = excluded.data'
    ),
    delRepos: db.prepare('DELETE FROM repos WHERE login = ?'),
    insRepo: db.prepare(
      `INSERT INTO repos (login, name, description, language, stars, forks, is_fork, archived, url, homepage, topics, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getRepos: db.prepare('SELECT * FROM repos WHERE login = ?'),
    delContribs: db.prepare('DELETE FROM contributions WHERE login = ?'),
    insContrib: db.prepare('INSERT INTO contributions (login, day, count) VALUES (?, ?, ?)'),
    getContribs: db.prepare('SELECT day, count FROM contributions WHERE login = ? ORDER BY day'),
    getRate: db.prepare('SELECT lim, remaining, reset, updated_at FROM rate_limit WHERE id = 1'),
    putRate: db.prepare(
      `INSERT INTO rate_limit (id, lim, remaining, reset, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lim = excluded.lim, remaining = excluded.remaining,
         reset = excluded.reset, updated_at = excluded.updated_at`
    ),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  return {
    allSettings: () => q.allSettings.all(),
    putSetting: (key, value) => q.putSetting.run(key, value),

    getMeta: (key) => q.getMeta.get(key) ?? null,
    putMeta: (key, { etag = null, fetchedAt, source = null, extra = null }) =>
      q.putMeta.run(key, etag, fetchedAt, source, extra),

    loadProfile: (login) => {
      const row = q.getProfile.get(login);
      return row ? JSON.parse(row.data) : null;
    },
    saveProfile: (login, profile) => q.putProfile.run(login, JSON.stringify(profile)),

    loadRepos: (login) =>
      q.getRepos.all(login).map((r) => ({
        name: r.name,
        description: r.description,
        language: r.language,
        stars: r.stars,
        forks: r.forks,
        isFork: !!r.is_fork,
        archived: !!r.archived,
        url: r.url,
        homepage: r.homepage,
        topics: JSON.parse(r.topics || '[]'),
        pushedAt: r.pushed_at,
      })),
    saveRepos: (login, repos) =>
      tx(() => {
        q.delRepos.run(login);
        for (const r of repos) {
          q.insRepo.run(
            login, r.name, r.description ?? null, r.language ?? null, r.stars ?? 0, r.forks ?? 0,
            r.isFork ? 1 : 0, r.archived ? 1 : 0, r.url ?? null, r.homepage || null,
            JSON.stringify(r.topics ?? []), r.pushedAt ?? null
          );
        }
      }),

    loadContribs: (login) => q.getContribs.all(login).map((r) => ({ date: r.day, count: r.count })),
    saveContribs: (login, days) =>
      tx(() => {
        q.delContribs.run(login);
        for (const d of days) q.insContrib.run(login, d.date, d.count);
      }),

    getRate: () => {
      const r = q.getRate.get();
      return r ? { limit: r.lim, remaining: r.remaining, reset: r.reset, updatedAt: r.updated_at } : null;
    },
    putRate: (rate) => q.putRate.run(rate.limit, rate.remaining, rate.reset, Date.now()),

    // Removes cached GitHub data but keeps the user's settings.
    clearCache: () =>
      tx(() => {
        for (const t of ['cache_meta', 'profiles', 'repos', 'contributions', 'rate_limit']) db.exec(`DELETE FROM ${t}`);
      }),
    stats: () => ({
      profiles: count('profiles'),
      repos: count('repos'),
      contributionDays: count('contributions'),
      cacheEntries: count('cache_meta'),
    }),
    close: () => db.close(),
  };
}
