import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallerContext } from '../server/caller-context.mjs';
const env = { CONTEXT_API_TOKEN: 'fixture-service-token-not-a-real-secret' };
test('caller context starts without a phone and sends the requested authorization fields', async () => {
  const calls = [];
  const client = createCallerContext({ env, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return { status: calls.length === 1 ? 201 : 200, json: async () => calls.length === 1 ? { session_token: 'private-session', expires_at: '2099-01-01T00:00:00Z', state: 'authorization_required' } : calls.length === 2 ? { profile: { display_name: 'Avery Chen', rank: 'Commander' } } : { state: 'ended' } };
  } });
  const started = await client.start();
  assert.equal(started.ok, true); assert.deepEqual(calls[0].body, {});
  const args = { name: 'Avery Chen', authorization: 'Alpha seven Bravo nine Echo two' };
  const result = await client.authorize(started.sessionToken, args);
  assert.deepEqual(calls[1].body, { session_token: 'private-session', ...args });
  assert.deepEqual(result, { ok: true, profile: { display_name: 'Avery Chen', rank: 'Commander' } });
  assert.equal(calls[1].redirect, 'error');
  await client.end(started.sessionToken);
  assert.deepEqual(calls[2].body, { session_token: 'private-session' });
});
test('missing credentials fail closed without making a request', async () => {
  const client = createCallerContext({ env: {}, fetchImpl: () => assert.fail('No network allowed') });
  assert.deepEqual(await client.start(), { ok: false, error: 'identity_service_not_configured' });
});
test('identity errors are sanitized without retries or raw provider messages', async () => {
  let calls = 0;
  const client = createCallerContext({ env, fetchImpl: async () => { calls++; return { status: 401, json: async () => ({ error: 'phrase_not_accepted', message: 'private fixture details' }) }; } });
  assert.deepEqual(await client.authorize('private', { name: 'Avery', authorization: 'incorrect' }), { ok: false, error: 'phrase_not_accepted' });
  assert.equal(calls, 1);
});
test('caller context rejects insecure or credential-bearing targets', () => {
  for (const base of ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=private']) assert.throws(() => createCallerContext({ env: { CONTEXT_API_BASE_URL: base } }));
});

test('identity controller ends a context created after channel cancellation', async () => {
  const { createIdentity } = await import('../server/identity.mjs');
  let resolveStart; const ended = [];
  const state = { authorized: false, attempts: 0 };
  const identity = createIdentity({ state, client: {
    start: () => new Promise(resolve => { resolveStart = resolve; }),
    end: async token => { ended.push(token); return { ok: true }; },
    authorize: () => assert.fail('Cancelled channels cannot authorize'),
  } });
  const starting = identity.start(); const ending = identity.end();
  resolveStart({ ok: true, sessionToken: 'late-private', expiresAt: '2099-01-01T00:00:00Z' });
  await starting; await ending;
  assert.deepEqual(ended, ['late-private']);
  assert.equal(state.authorized, false);
});
test('identity controller does not start before greeting readiness and uses returned profile', async () => {
  const { createIdentity } = await import('../server/identity.mjs');
  const state = { authorized: false, attempts: 0 }; let starts = 0;
  const profile = { display_name: 'Tavi Rourke', rank: 'Lieutenant', ship: 'USS Wayfinder' };
  const identity = createIdentity({ state, client: {
    start: async () => { starts++; return { ok: true, sessionToken: 'private', expiresAt: '2099-01-01T00:00:00Z' }; },
    authorize: async () => ({ ok: true, profile }), end: async () => ({ ok: true }),
  } });
  assert.equal((await identity.authorize({})).error, 'identity_not_ready'); assert.equal(starts, 0);
  await identity.start(); await identity.start(); assert.equal(starts, 1);
  assert.equal((await identity.authorize({ name: 'Tavi Rourke', authorization: 'supplied' })).ok, true);
  assert.equal(state.profile, profile); assert.equal(identity.valid(), true);
  await identity.end(); assert.equal(identity.valid(), false);
});

test('an authorization schema rejection is not reported as service unavailable', async () => {
  const diagnostics = [];
  const client = createCallerContext({ env, onDiagnostic: event => diagnostics.push(event), fetchImpl: async () => ({ status: 400, json: async () => ({ error: 'invalid_body', message: 'private provider details' }) }) });
  assert.deepEqual(await client.authorize('private', { name: 'Avery Chen', authorization: 'supplied phrase' }), { ok: false, error: 'identity_request_rejected' });
  assert.deepEqual(diagnostics, [{ event: 'identity_request_failed', operation: 'authorize', status: 400, code: 'identity_request_rejected' }]);
  assert.equal(JSON.stringify(diagnostics).includes('private'), false);
});

test('trusted crew UUID is accepted only from the identity response, never inferred from name', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const client = createCallerContext({ env, fetchImpl: async () => ({ status: 200, json: async () => ({ crew_member_id: uuid, profile: { display_name: 'Avery Chen' } }) }) });
  assert.equal((await client.authorize('session', { name: 'Avery Chen', authorization: 'phrase' })).crewMemberId, uuid);
});
