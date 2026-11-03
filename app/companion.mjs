import { readFile } from 'node:fs/promises';
import { fixtureFrames } from './fixtures.mjs';

const assets = new Map([
  ['/', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/web/app.js', ['../web/app.js', 'text/javascript; charset=utf-8']],
  ['/web/app.css', ['../web/app.css', 'text/css; charset=utf-8']],
  ['/design-system/tokens.css', ['../design-system/tokens.css', 'text/css; charset=utf-8']],
  ['/design-system/components.css', ['../design-system/components.css', 'text/css; charset=utf-8']],
]);
export function createCompanion({ intervalMs = 8000, heartbeatMs = 15000 } = {}) {
  const clients = new Set();
  return {
    async handle(req, res) {
      if (req.method !== 'GET') return false;
      const url = new URL(req.url, 'http://local.invalid');
      const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
      if (url.pathname === '/events') {
        const scenario = url.searchParams.get('scenario') ?? 'repair';
        const frames = fixtureFrames(scenario);
        if (!frames) { res.writeHead(400, security); res.end('Unknown fixture.'); return true; }
        if (clients.size >= 32) { res.writeHead(503, security); res.end('Preview busy.'); return true; }
        // Reconnect from the last complete snapshot; IDs are scoped to a scenario.
        let index = 0;
        const match = new RegExp(`^${scenario}:(\\d+)$`).exec(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '');
        if (match) index = Math.min(Number(match[1]) + 1, frames.length - 1);
        res.writeHead(200, { ...security, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        let timer, heartbeat, closed = false;
        const cleanup = () => { if (closed) return; closed = true; clearInterval(timer); clearInterval(heartbeat); clients.delete(res); };
        res.once('close', cleanup);
        clients.add(res);
        const next = () => {
          if (closed) return;
          const ok = res.write(`id: ${scenario}:${index}\nevent: snapshot\ndata: ${JSON.stringify(frames[index])}\n\n`);
          index++;
          if (!ok) { cleanup(); res.destroy(); return; }
          if (index === frames.length) { res.write('event: complete\ndata: {}\n\n'); cleanup(); res.end(); }
        };
        timer = setInterval(next, intervalMs);
        heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) { cleanup(); res.destroy(); } }, heartbeatMs);
        next();
        return true;
      }
      const asset = assets.get(url.pathname);
      if (!asset) return false;
      const content = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, { ...security, 'Content-Type': asset[1] }); res.end(content); return true;
    },
    close() { for (const res of clients) res.end(); clients.clear(); },
  };
}
