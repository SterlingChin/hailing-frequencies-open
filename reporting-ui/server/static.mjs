import path from 'node:path';
import { readFile } from 'node:fs/promises';

export async function serveStatic(req, res, directory, readFileImpl = readFile) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
    const file = pathname === '/' ? path.join(directory, 'index.html') : path.resolve(directory, `.${pathname}`);
    if (!file.startsWith(path.resolve(directory) + path.sep)) { res.writeHead(404).end(); return; }
    const data = await readFileImpl(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end('Not found. Run npm run build before starting production.'); }
}
