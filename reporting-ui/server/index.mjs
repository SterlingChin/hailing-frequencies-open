import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApi } from './api.mjs';
import { serveStatic } from './static.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
const api = createApi();
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const tls = process.env.TLS_KEY_FILE && process.env.TLS_CERT_FILE
  ? { key: await readFile(process.env.TLS_KEY_FILE), cert: await readFile(process.env.TLS_CERT_FILE) } : null;
let vite;
async function handler(req, res) {
  if (await api.handle(req, res)) return;
  if (vite) { vite.middlewares(req, res); return; }
  await serveStatic(req, res, path.join(root, 'dist'));
}
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
if (!production) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true, hmr: { server }, fs: { allow: [root, path.resolve(root, '../design-system')] } }, appType: 'spa' });
}
server.listen(port, host, () => console.log(`Hailing Frequencies: ${tls ? 'https' : 'http'}://${host}:${port} (${production ? 'built app' : 'Vite'})`));
server.on('error', () => { console.error('Could not start the server. Check HOST, PORT and port availability.'); process.exitCode = 1; void shutdown(); });
async function shutdown() { api.close(); await vite?.close(); server.close(); setTimeout(() => process.exit(0), 4500).unref(); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
