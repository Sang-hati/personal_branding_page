# Developer dashboard

A personal branding page for your GitHub activity: a contribution heatmap, streaks, a language breakdown and repository cards. A small Node server fetches data from GitHub and caches it in SQLite so the page loads fast and stays inside GitHub's rate limits.

## Run it

Needs Node 22.13 or newer. There is nothing to install: no dependencies, and SQLite is built into Node.

```bash
npm run demo     # sample data, works offline
npm start        # your real GitHub data
```

Then open http://127.0.0.1:3000. On first run, enter your GitHub username (or set `GITHUB_USERNAME`).

### Add a token (recommended)

Copy `.env.example` to `.env` and set `GITHUB_TOKEN`.

| | No token | With token |
|---|---|---|
| Contribution calendar | Estimated from public events, last 90 days at most | Full year from the GraphQL API |
| Requests per hour | 60 | 5,000 |

A fine-grained token with read-only access to public data is enough. The token stays on the server and is never sent to the browser.

## What you get

- **Contribution heatmap**: 53 weeks by 7 days, coloured by intensity (quartiles of your active days, so one huge day does not wash out the rest). Hover a day for its count. Switch to the monthly table for a screen-reader-friendly view.
- **Streaks**: current and longest, plus active days and busiest day. Hover or click a streak to highlight those days on the grid. An empty "today" does not break your current streak.
- **Repository cards**: stars, forks, language tag, description and last push. The top repository is featured at double width. Search, filter by language (or click the language bar), sort, and pin repositories to the top.
- **Settings**: username, light/dark/system theme, how many repositories show at first, hide forks and archived repositories, cache lifetimes. Saved in SQLite.

## How the cache works

Everything goes through one function in `src/service.js`:

1. **Fresh copy in SQLite** (younger than its lifetime): served immediately, no network. Defaults: profile 60 min, repositories 30 min, contributions 6 h.
2. **Otherwise** GitHub is asked with the saved ETag. A `304 Not Modified` costs nothing against the rate limit, and **Refresh data** uses this too.
3. **GitHub unavailable or rate limited**: the saved copy is served and the page says so.
4. Concurrent requests for the same resource share one call to GitHub.

Data lives in `data/cache.sqlite` (`data/demo.sqlite` in demo mode). "Clear cached data" in Settings wipes the cache and keeps your settings.

## Layout

```
server.js            HTTP server and routes (no framework)
src/db.js            SQLite schema and queries (node:sqlite)
src/github.js        GitHub REST and GraphQL client
src/service.js       Cache, settings, dashboard assembly
src/streaks.js       Intensity levels and streak maths
src/demo.js          Offline sample-data provider
public/              index.html, styles.css, app.js (no build step)
test/                npm test
```

### API

| Route | Purpose |
|---|---|
| `GET /api/dashboard?user=&refresh=1` | Profile, calendar, streaks, repositories, cache status |
| `GET /api/settings`, `PUT /api/settings` | Read and update settings |
| `GET /api/status` | Provider, token present, row counts, rate limit |
| `POST /api/cache/clear` | Delete cached GitHub data |

The server listens on `127.0.0.1` only, rejects cross-origin writes, and serves a strict Content-Security-Policy. Set `HOST` and `PORT` to change that.

## Notes

- Fonts (Bricolage Grotesque and Newsreader) load from Google Fonts; the page falls back to system fonts offline.
- The language bar counts repositories per language, not lines of code, and skips forks.
- Without a token, events older than 90 days or beyond the newest 300 are not available from GitHub, so those days show as dashed "no data" cells rather than zeros.
