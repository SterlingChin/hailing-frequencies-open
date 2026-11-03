import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api-client.js';
test('a browser session lost on redeploy is recovered before retrying Engage once', async () => {
  let csrf = 'old'; const calls = [];
  const request = createApiClient({ getCsrf: () => csrf, setCsrf: value => { csrf = value; }, fetchImpl: async (path, options) => {
    calls.push({ path, csrf: options.headers['X-CSRF-Token'] });
    const status = calls.length === 1 ? 401 : 200;
    return { status, ok: status === 200, json: async () => status === 401 ? { code: 'browser_session_reset' } : path === '/api/session' ? { csrf: 'fresh' } : { sdp: 'answer' } };
  } });
  assert.deepEqual(await request('/api/begin', { sdp: 'offer' }), { sdp: 'answer' });
  assert.deepEqual(calls, [{ path: '/api/begin', csrf: 'old' }, { path: '/api/session', csrf: undefined }, { path: '/api/begin', csrf: 'fresh' }]);
});
test('provider or ordinary authorization failures never trigger retry', async () => {
  let calls = 0;
  const request = createApiClient({ getCsrf: () => 'csrf', setCsrf: () => assert.fail('No reset'), fetchImpl: async () => { calls++; return { status: 502, ok: false, json: async () => ({ error: 'Provider failed' }) }; } });
  await assert.rejects(request('/api/begin', {}), /Provider failed/); assert.equal(calls, 1);
});
