// HTTP server: a small JSON API plus the static frontend. No dependencies.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from './src/db.js';
import { githubProvider } from './src/github.js';
import { demoProvider } from './src/demo.js';
import { createService, HttpError } from './src/service.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* .env is optional */
}

const demo = process.argv.includes('--demo') || process.env.DEMO === '1';
const token = demo ? null : process.env.GITHUB_TOKEN?.trim() || null;
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

// Demo data lives in its own database so it never mixes with real cached data.
const store = openStore(join(ROOT, 'data', demo ? 'demo.sqlite' : 'cache.sqlite'));
const service = createService({ store, provider: demo ? demoProvider : githubProvider, token });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    ...headers,
  });
  res.end(body);
}

const sendJson = (res, status, payload) =>
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  // Changing anything must come from this page, not from another site open in the same browser.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }

  switch (route) {
    case 'GET /api/dashboard':
      return sendJson(res, 200, await service.getDashboard({
        user: url.searchParams.get('user') || undefined,
        force: url.searchParams.get('refresh') === '1',
      }));
    case 'GET /api/settings':
      return sendJson(res, 200, service.getSettings());
    case 'PUT /api/settings':
      return sendJson(res, 200, service.updateSettings(await readJson(req)));
    case 'GET /api/status':
      return sendJson(res, 200, service.getStatus());
    case 'POST /api/cache/clear':
      service.clearCache();
      return sendJson(res, 200, { ok: true });
    default:
      throw new HttpError(404, 'Unknown API route.');
  }
}

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(403, 'Forbidden.');
  let body;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
  send(res, 200, req.method === 'HEAD' ? undefined : body, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (err) {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error(err);
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, status, { error: err.message, rateLimited: !!err.rateLimited, resetAt: err.resetAt ?? null });
    } else {
      send(res, status, err.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }
});

server.listen(port, host, () => {
  const mode = demo
    ? 'demo data (no network calls)'
    : token
      ? 'GitHub GraphQL calendar (token found)'
      : 'public events only, add GITHUB_TOKEN for the full calendar';
  console.log(`Developer dashboard running at http://${host}:${port}`);
  console.log(`Data source: ${mode}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
