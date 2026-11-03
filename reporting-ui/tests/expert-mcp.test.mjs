import test, { after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchStore } from '../server/dispatch-store.mjs';
const directories = [];
after(() => Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))));
import assert from 'node:assert/strict';
import { createExpertRouter } from '../server/expert-mcp.mjs';
function fixture(result = { structuredContent: { outcome: 'ANSWERED', answer: 'Replace the fuse.' } }, directory = mkdtempSync(join(tmpdir(), 'hf-router-'))) {
  directories.push(directory);
  const calls = [];
  const router = createExpertRouter({ env: { SPECIALISTS_MCP_TOKEN: 'fixture-secret' }, dispatchStore: createDispatchStore({ directory }), fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    if (request.method === 'tools/call' && result instanceof Error) throw result;
    const data = request.method === 'tools/list' ? { tools: [{ name: 'maintenance', inputSchema: { type: 'object', properties: { question: { type: 'string' }, context: { type: 'string' } }, required: ['question'] } }] } : result;
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: data }) };
  } });
  return { router, calls, directory };
}
const decision = { outcome: 'queue', route: 'maintenance', task_id: 'task-1', reused: false, crm_context: { selected_case: { id: 'HF-001', symptom: 'broken' } } };
test('discovers the maintenance tool before calling it with the decision CRM snapshot', async () => {
  const f = fixture();
  const answer = await f.router.dispatch(decision, 'The replicator stopped.');
  assert.equal(answer.status, 'answer_ready'); assert.equal(answer.answer, 'Replace the fuse.');
  assert.deepEqual(f.calls.map(call => call.method), ['tools/list', 'tools/call']);
  assert.equal(f.calls[1].params.name, 'maintenance');
  assert.equal(f.calls[1].params.arguments.question, 'The replicator stopped.');
  assert.deepEqual(JSON.parse(f.calls[1].params.arguments.context), decision.crm_context);
  assert.deepEqual(f.calls[0].params._meta['io.modelcontextprotocol/clientCapabilities'], {});
  await f.router.dispatch(decision, 'duplicate'); assert.equal(f.calls.length, 2);
});
test('stored answers, missing details, undecided routes and reused tasks never invoke experts', async () => {
  const f = fixture();
  for (const outcome of ['solution', 'needs_more_details', 'undecided']) assert.equal(await f.router.dispatch({ ...decision, outcome }, 'request'), null);
  assert.equal((await f.router.dispatch({ ...decision, reused: true }, 'request')).status, 'existing_task');
  assert.equal(f.calls.length, 0);
});
test('IT cannot silently fall back to the only advertised Maintenance tool', async () => {
  const f = fixture();
  assert.equal((await f.router.dispatch({ ...decision, route: 'it' }, 'request')).status, 'tool_unavailable');
  assert.deepEqual(f.calls.map(call => call.method), ['tools/list']);
});
test('dispatch acknowledgment and unknown results are not finished answers', async () => {
  const f = fixture({ structuredContent: { outcome: 'EXPERT_AGENT_DISPATCHED', dispatchId: 'dispatch-1', summary: 'triage only' } });
  const result = await f.router.dispatch(decision, 'request');
  assert.equal(result.status, 'dispatched'); assert.equal(result.answer, undefined);
  assert.equal((await f.router.refresh(result)).status, 'dispatched');
  const uncertain = fixture({ content: [{ type: 'text', text: 'unstructured triage' }] });
  assert.equal((await uncertain.router.dispatch(decision, 'request')).status, 'unconfirmed');
});
test('lost tools/call response is retained as unknown without automatic redispatch', async () => {
  let calls = 0;
  const router = createExpertRouter({ fetchImpl: async (_url, options) => {
    calls++; const request = JSON.parse(options.body);
    if (request.method === 'tools/call') throw new Error('timeout');
    return { ok: true, headers: new Headers(), text: async () => JSON.stringify({ id: request.id, result: { tools: [{ name: 'maintenance', inputSchema: { properties: { question: { type: 'string' } }, required: ['question'] } }] } }) };
  } });
  assert.equal((await router.dispatch(decision, 'request')).status, 'unconfirmed');
  await router.dispatch(decision, 'request'); assert.equal(calls, 2);
});

test('ending a channel during discovery prevents new expert work', async () => {
  const f = fixture();
  const result = await f.router.dispatch(decision, 'request', () => true);
  assert.equal(result.status, 'cancelled'); assert.equal(f.calls.length, 1);
});

test('a new service handoff dispatches the advertised expert with its immutable arguments', async () => {
  const f = fixture();
  const result = await f.router.dispatch({ ...decision, action: { type: 'route_to_expert', dispatch_policy: 'claim_before_dispatch', dispatch_key: decision.task_id, tool_call: { name: 'maintenance', arguments: { question: 'Immutable original assignment', context: 'original task snapshot' } } } }, 'new caller wording');
  assert.equal(result.status, 'answer_ready');
  assert.deepEqual(f.calls.map(call => call.method), ['tools/list', 'tools/call']);
  assert.deepEqual(f.calls[1].params.arguments, { question: 'Immutable original assignment', context: 'original task snapshot' });
});

test('an explicit handoff to an unadvertised tool does not fall back by desk', async () => {
  const f = fixture();
  const result = await f.router.dispatch({ ...decision, action: { dispatch_policy: 'claim_before_dispatch', dispatch_key: decision.task_id, tool_call: { name: 'expert_engineering', arguments: { question: 'assignment', context: 'snapshot' } } } }, 'request');
  assert.equal(result.status, 'tool_unavailable'); assert.equal(f.calls.length, 1);
});

const handoffDecision = { ...decision, action: { type: 'route_to_expert', dispatch_policy: 'claim_before_dispatch', dispatch_key: 'durable-task', tool_call: { name: 'maintenance', arguments: { question: 'original assignment', context: 'original context' } } } };
test('independent routers claim once and restart/reused handoffs restore the saved receipt', async () => {
 const first = fixture(), second = fixture(undefined, first.directory);
 await Promise.all([first.router.dispatch(handoffDecision, 'caller'), second.router.dispatch(handoffDecision, 'caller')]);
 assert.equal([...first.calls, ...second.calls].filter(call => call.method === 'tools/call').length, 1);
 const reconciled = await second.router.dispatch({ ...handoffDecision, reused: true }, 'caller');
 assert.equal(reconciled.status, 'answer_ready');
 const fresh = fixture(undefined, first.directory);
 const restored = await fresh.router.dispatch({ ...handoffDecision, reused: true, action: { ...handoffDecision.action, dispatch_policy: 'reconcile_existing' } }, 'changed caller request');
 assert.equal(restored.status, 'answer_ready'); assert.equal(restored.answer, 'Replace the fuse.'); assert.equal(fresh.calls.length, 0);
});
test('lost expert outcomes are persisted and never replayed by a fresh router', async () => {
 const first = fixture(new Error('lost response'));
 assert.equal((await first.router.dispatch(handoffDecision, 'caller')).status, 'unconfirmed');
 const fresh = fixture(undefined, first.directory);
 assert.equal((await fresh.router.dispatch(handoffDecision, 'caller')).status, 'unconfirmed');
 assert.equal(fresh.calls.filter(call => call.method === 'tools/call').length, 0);
});
