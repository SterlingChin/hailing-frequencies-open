import test from 'node:test';
import assert from 'node:assert/strict';
import { createCRMClient, createCRMContext } from '../server/crm-context.mjs';
import { contextSummary } from '../src/context-view.js';
test('CRM token stays in server requests and Decisions uses the reporting session', async () => {
  const calls = [];
  const client = createCRMClient({ env: { REPORTING_API_TOKEN: 'private-fixture', HF_BACKEND_URL: 'https://context.example.test' }, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, session_token: 'private-session' }) };
  } });
  await client.start('channel-123'); await client.call('private-session', 'open_case', { equipment_id: 'equipment', symptom: 'stuck' });
  await client.call('private-session', 'route_request', { request: 'hatch stuck', ignored: 'not forwarded' }); await client.end('private-session');
  assert.deepEqual(calls[0].body, { action: 'start', channel_id: 'channel-123' });
  assert.deepEqual(calls[2].body, { session_token: 'private-session', request: 'hatch stuck' });
  assert.equal(calls[2].url, 'https://context.example.test/api/decisions');
  assert.equal(calls[2].redirect, 'error');
});
test('context loads the actual phrase and preserves decision facts without dispatching agents', async () => {
  const state = { channelId: 'channel-123' }, calls = [];
  const context = { profile: { display_name: 'Tavi Rourke' }, selected_case: { id: 'HF-001', symptom: 'cannot open report' }, queue: [] };
  const crm = createCRMContext({ state, client: {
    start: async () => ({ ok: true, session_token: 'private' }),
    call: async (token, name, args) => { calls.push({ token, name, args }); return name === 'route_request' ? { ok: true, outcome: 'queue', route: 'it', task_id: 'task-1', reused: true, crm_context: context } : { ok: true, crm_context: context }; },
    end: async () => ({ ok: true }),
  } });
  assert.equal((await crm.call('route_request', { request: 'issue' })).error.code, 'profile_required');
  await crm.load('actually spoken'); assert.deepEqual(calls[0].args, { spoken_code: 'actually spoken' });
  await crm.call('route_request', { request: 'cannot open report' });
  assert.equal(state.decision.reused, true); assert.equal(state.crmContext, context);
  assert.equal(JSON.stringify(state).includes('private'), false);
  await crm.call('update_symptom', { symptom: 'changed' }); assert.equal(state.decision, null);
  await crm.end(); assert.equal((await crm.call('get_crm_context', {})).error.code, 'channel_ended');
});
test('context never selects cases or requests Decisions before case confirmation', async () => {
  const state = {}; let calls = 0;
  const crm = createCRMContext({ state, client: { start: async () => ({ ok: true, session_token: 'private' }), call: async () => { calls++; return { ok: true, crm_context: { selected_case: null } }; }, end: async () => ({ ok: true }) } });
  await crm.load('phrase');
  assert.equal((await crm.call('route_request', { request: 'issue' })).error.code, 'case_required');
  assert.equal((await crm.call('resume_case', { case_id: 'HF-001', caller_confirmed: false })).error.code, 'invalid_arguments');
  assert.equal(calls, 1); await crm.end();
});
test('a late CRM start is ended once after channel cancellation', async () => {
  let finish; const ended = [];
  const crm = createCRMContext({ state: {}, client: { start: () => new Promise(resolve => { finish = resolve; }), call: () => assert.fail('No profile request after cancellation'), end: async token => { ended.push(token); return { ok: true }; } } });
  const load = crm.load('phrase'), end = crm.end(); finish({ ok: true, session_token: 'late-private' });
  await load; await end; assert.deepEqual(ended, ['late-private']);
});
test('UI does not translate pending work into specialist activity or completion', () => {
  const result = contextSummary({ active: false, contextStatus: 'ready', crmContext: { queue: [{ id: 'task', specialist: 'it', status: 'working' }] }, decision: { outcome: 'queue', route: 'it', reused: true } });
  assert.equal(result.status, 'Last recorded context');
  assert.match(result.tasks[0].status, /activity not confirmed/);
  assert.match(result.decision, /existing task retained/); assert.match(result.detail, /not confirmed/);
});

test('Decisions queue snapshot is refreshed to include the newly recorded task', async () => {
  const state = {}, before = { selected_case: { id: 'HF-001' }, queue: [] };
  const after = { ...before, queue: [{ id: 'new-task', specialist: 'maintenance', status: 'working' }] };
  const crm = createCRMContext({ state, client: { start: async () => ({ ok: true, session_token: 'private' }), end: async () => ({ ok: true }), call: async (_token, name) => name === 'route_request' ? { ok: true, outcome: 'queue', route: 'maintenance', task_id: 'new-task', crm_context: before } : { ok: true, crm_context: name === 'get_crm_context' ? after : before } } });
  await crm.load('actual phrase'); await crm.call('route_request', { request: 'replicator stops' });
  assert.equal(state.crmContext.queue[0].id, 'new-task'); assert.equal(state.decision.outcome, 'queue');
  await crm.end();
});

test('selecting a different case or changing its symptom clears the old expert answer', async () => {
  const state = {}, crm = createCRMContext({ state, client: { start: async () => ({ ok: true, session_token: 'private' }), call: async () => ({ ok: true, crm_context: { selected_case: { id: 'HF-002' } } }), end: async () => ({ ok: true }) } });
  await crm.load('phrase'); state.expert = { answer: 'Old case answer' };
  await crm.call('resume_case', { case_id: 'HF-002', caller_confirmed: true }); assert.equal(state.expert, null);
  state.expert = { answer: 'Old symptom answer' };
  await crm.call('update_symptom', { symptom: 'Changed' }); assert.equal(state.expert, null);
  await crm.end();
});

test('PR12 intake posts only authenticated crew UUID and conversation context', async () => {
  let body;
  const client = createCRMClient({ env: { REPORTING_API_TOKEN: 'fixture' }, fetchImpl: async (url, options) => { assert.match(url, /\/api\/decisions$/); body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ ok: true, context_id: 'receipt' }) }; } });
  await client.submit('server-owned-uuid', 'Caller: The hatch is stuck.');
  assert.deepEqual(body, { crew_member_id: 'server-owned-uuid', context: 'Caller: The hatch is stuck.' });
});

test('Decisions nonexistent-ship result reaches the voice agent without raw backend details', async () => {
  const client = createCRMClient({ env: { REPORTING_API_TOKEN: 'fixture' }, fetchImpl: async () => ({ ok: false, status: 404,
    json: async () => ({ ok: false, error: { code: 'crew_member_not_found', reason: 'ship_not_found', message: 'private backend detail' } }) }) });
  assert.deepEqual(await client.submit('crew-id', 'Caller: Need help.'),
    { ok: false, error: { code: 'crew_member_not_found', reason: 'ship_not_found' } });
});
