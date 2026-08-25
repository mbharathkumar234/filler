#!/usr/bin/env node
/**
 * Serves fixtures/ on http://localhost:4173 so e2e tests never touch a live
 * portal (§ Phase 0 Should Achieve, §6.1).
 *
 * Deliberately minimal: static files, no directory traversal, no upload
 * endpoint, localhost only. This server must never gain the ability to accept
 * a form submission — an e2e run that can POST somewhere is a run that can
 * leak a fixture's contents.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../fixtures', import.meta.url)));
const PORT = Number(process.env.FIXTURES_PORT ?? 4173);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/** Resolve a URL path to a file inside ROOT, or null if it escapes. */
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const candidate = resolve(join(ROOT, normalize(decoded)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

async function renderIndex(res) {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const items = dirs.map((d) => `<li><a href="/${d}/page-1.html">${d}</a></li>`).join('');
  send(
    res,
    200,
    `<!doctype html><meta charset="utf-8"><title>Fixtures</title>
     <h1>Fixture portals</h1>
     <p>Served from <code>fixtures/</code>. These are local copies — no live portal is contacted.</p>
     <ul>${items || '<li><em>No fixtures saved yet.</em></li>'}</ul>`,
    { 'content-type': 'text/html; charset=utf-8' },
  );
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    }

    const urlPath = req.url ?? '/';
    if (urlPath === '/' || urlPath.startsWith('/?')) return renderIndex(res);

    const filePath = safeResolve(urlPath);
    if (!filePath) return send(res, 403, 'Forbidden');

    try {
      const info = await stat(filePath);
      if (info.isDirectory()) return send(res, 404, 'Not Found');
      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath).pipe(res);
      return undefined;
    } catch {
      return send(res, 404, 'Not Found');
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`fixtures served at http://localhost:${PORT}/ (from ${ROOT})`);
});
