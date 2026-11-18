// Local preview: serves public/ and the same API handlers Vercel runs, with dev sign-in and an
// in-memory store. Nothing here talks to Clerk or Blob, and everything is gone when it stops.
//   npm run dev                      → http://localhost:4173
//   npm run dev -- --port 5000
//   npm run dev -- --seed file.json  → start with an export file already imported
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : ''; };
const port = Number(flag('port')) || 4173;
const root = resolve(fileURLToPath(new URL('../public', import.meta.url)));

if (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') throw new Error('The dev server is for local use only.');
process.env.LUMI_DEV_AUTH = '1';
process.env.LUMI_PUBLISH_ORIGIN ||= `http://localhost:${port}`;
process.env.LUMI_PUBLISH_SECRET ||= randomBytes(32).toString('hex'); // new every run; the store is in memory anyway
delete process.env.BLOB_READ_WRITE_TOKEN;

const routes = {
  '/api/app': (await import('../api/app.js')).default,
  '/api/media': (await import('../api/media.js')).default,
  '/api/callback/instagram': (await import('../api/callback/instagram.js')).default,
  '/api/callback/facebook': (await import('../api/callback/facebook.js')).default,
  '/api/callback/youtube': (await import('../api/callback/youtube.js')).default,
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const seed = flag('seed');
if (seed) {
  const { importDesk } = await import('../server/data.js');
  const { backendFor, tenantStore } = await import('../server/store.js');
  const identity = { userId: 'user_dev', tenantId: 'user_dev', tenantKind: 'user', role: 'admin' };
  const result = await importDesk(tenantStore(backendFor(), identity.tenantId), identity, JSON.parse(await readFile(seed, 'utf8')));
  console.log('seeded:', JSON.stringify(result.imported));
}

createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, 'http://local.invalid');
    if (routes[pathname]) return await routes[pathname](request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const file = normalize(join(root, ['/', '/sign-in', '/sign-up'].includes(pathname) ? 'index.html' : decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file).pipe(response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`LUMI 发布台 (local preview) → http://localhost:${port}`));
