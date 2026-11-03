import test from 'node:test';
import assert from 'node:assert/strict';
import { serveStatic } from '../server/static.mjs';

function response() { return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; }, writeHead(status) { this.statusCode = status; return this; } }; }
test('production root serves the built index and assets with their MIME types', async () => {
  const reads = [], readFileImpl = async path => { reads.push(path); return 'fixture'; };
  const res = response();
  await serveStatic({ url: '/', method: 'GET' }, res, '/app/dist', readFileImpl);
  assert.equal(reads[0], '/app/dist/index.html');
  assert.equal(res.headers['Content-Type'], 'text/html');
  const asset = response();
  await serveStatic({ url: '/assets/main.js', method: 'GET' }, asset, '/app/dist', readFileImpl);
  assert.equal(asset.headers['Content-Type'], 'text/javascript');
});
test('production static server rejects traversal, secrets, and mutations', async () => {
  for (const url of ['/../server/index.mjs', '/%2e%2e/.env', '/.env', '/%2e%2e%2f.env']) {
    let read = false; const res = response();
    await serveStatic({ url, method: 'GET' }, res, '/app/dist', async () => { read = true; });
    assert.equal(res.statusCode, 404); assert.equal(read, false);
  }
  const post = response();
  await serveStatic({ url: '/', method: 'POST' }, post, '/app/dist', () => assert.fail());
  assert.equal(post.statusCode, 405);
});
