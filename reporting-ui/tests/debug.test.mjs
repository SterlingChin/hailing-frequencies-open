import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugFetch } from '../server/debug.mjs';
test('records raw success and failure bodies without consuming the response or leaking credentials', async () => {
 const state = {}, emitted = [];
 const observed = createDebugFetch({ state, secrets: ['private-test-key'], notify: () => emitted.push(true), fetchImpl: async () => new Response(JSON.stringify({ outcome: 'undecided', reason: 'low_route_confidence', session_token: 'private-session', context: { authorization: 'secret phrase', note: 'private-test-key' } }), { status: 200 }) });
 const response = await observed('https://example.test/api/decisions', { method: 'POST' });
 assert.equal((await response.json()).session_token, 'private-session');
 assert.equal(state.debugResponses[0].status, 200);
 const body = JSON.parse(state.debugResponses[0].body);
 assert.equal(body.reason, 'low_route_confidence');
 assert.equal(body.session_token, '[REDACTED]');
 assert.equal(body.context.authorization, '[REDACTED]');
 assert.equal(body.context.note, '[REDACTED]');
 assert.equal(emitted.length, 1);
});
test('retains non-JSON failures, MCP bodies and transport errors in isolated bounded histories', async () => {
 const state = {}, other = {};
 const observed = createDebugFetch({ state, fetchImpl: async () => new Response('upstream refused', { status: 503 }) });
 for (let i=0;i<22;i++) await observed('https://example.test/mcp', { method: 'POST', body: JSON.stringify({ method: 'tools/list' }) });
 assert.equal(state.debugResponses.length, 20); assert.equal(state.debugDropped, 2);
 assert.equal(state.debugResponses.at(-1).operation, 'tools/list');
 assert.equal(state.debugResponses.at(-1).body, 'upstream refused'); assert.equal(other.debugResponses, undefined);
 const failed = createDebugFetch({ state, fetchImpl: async () => { throw new Error('private failure'); } });
 await assert.rejects(failed('https://example.test/api/test'));
 assert.equal(state.debugResponses.at(-1).status, null);
});
test('redacts freshly minted response credentials even when echoed in another text field', async () => {
 const state = {};
 const observed = createDebugFetch({ state, fetchImpl: async () => new Response(JSON.stringify({ session_token: 'minted-secret', message: 'Created minted-secret', content: [{ text: '{"access_token":"nested-secret","message":"nested-secret issued"}' }] })) });
 await observed('https://example.test/start');
 assert.equal(state.debugResponses[0].body.includes('minted-secret'), false);
 assert.equal(state.debugResponses[0].body.includes('nested-secret'), false);
});
