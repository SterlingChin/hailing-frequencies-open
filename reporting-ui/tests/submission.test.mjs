import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmission } from '../server/submission.mjs';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(action = { type: 'gather_context' }) {
  const state = { authorized: true, crewMemberId: id, report: { id: 'HF-draft', revision: 'version-1', issue: 'Stuck hatch' } };
  const calls = [], experts = [];
  const client = { submit: async (...args) => { calls.push(args); return { ok: true, context_id: 'receipt', action, context: { version: 2, profile: {}, cases: [] } }; } };
  const submission = createSubmission({ state, client, expertRouter: { dispatch: async (...args) => { experts.push(args); return { status: 'answer_ready', answer: 'Check the latch' }; } } });
  const args = { report_id: 'HF-draft', report_revision: 'version-1', context: 'Caller: The hatch is stuck. Reporter: Is that correct? Caller: Yes.', caller_confirmed: true };
  return { state, calls, experts, submission, args };
}
test('confirmed intake attaches server-owned crew ID and deduplicates a report revision', async () => {
  const f = fixture(); await f.submission.submit(f.args); await f.submission.submit(f.args);
  assert.equal(f.calls[0][0], id); assert.match(f.calls[0][1], /Confirmed issue: Stuck hatch/); assert.match(f.calls[0][1], /Caller: Yes/); assert.equal(f.calls.length, 1); assert.equal(f.state.report.delivery, 'recorded'); assert.equal(f.state.report.contextId, 'receipt'); assert.equal(f.experts.length, 0);
});
test('spoken confirmation, current draft and trusted identity ID are required before POST', async () => {
  const f = fixture();
  assert.equal((await f.submission.submit({ ...f.args, caller_confirmed: false })).error.code, 'spoken_confirmation_required');
  assert.equal((await f.submission.submit({ ...f.args, report_revision: 'old' })).error.code, 'report_changed');
  delete f.state.crewMemberId;
  assert.equal((await f.submission.submit(f.args)).error.code, 'identity_id_missing'); assert.equal(f.calls.length, 0);
});
test('only the external route_to_expert action triggers MCP execution', async () => {
  for (const action of [null, { type: 'respond' }, { type: 'gather_context' }]) { const f = fixture(action); await f.submission.submit(f.args); assert.equal(f.experts.length, 0); }
  const action = { type: 'route_to_expert', desk: 'maintenance', task_id: 'task', dispatch_policy: 'claim_before_dispatch', tool_call: { name: 'maintenance', arguments: { question: 'provided', context: 'original snapshot' } } };
  const f = fixture(action); await f.submission.submit(f.args);
  assert.equal(f.experts[0][0].action, action); assert.equal(f.state.expert.answer, 'Check the latch');
});
test('a lost submission response is never automatically posted a second time', async () => {
  const f = fixture(); let calls = 0;
  f.submission = createSubmission({ state: f.state, client: { submit: async () => { calls++; throw new Error('timeout'); } } });
  assert.equal((await f.submission.submit(f.args)).error.code, 'submission_outcome_unknown'); await f.submission.submit(f.args); assert.equal(calls, 1); assert.equal(f.state.report.delivery, 'unconfirmed');
});
test('a nonexistent ship is a definite rejected report, not an uncertain delivery', async () => {
  const f = fixture();
  f.submission = createSubmission({ state: f.state, client: { submit: async () => ({ ok: false,
    error: { code: 'crew_member_not_found', reason: 'ship_not_found' } }) } });
  assert.deepEqual(await f.submission.submit(f.args), { ok: false,
    error: { code: 'crew_member_not_found', reason: 'ship_not_found' } });
  assert.equal(f.state.report.delivery, 'rejected');
  assert.equal(f.state.report.contextId, undefined);
});
test('ending the channel during submission retains receipt without starting an expert', async () => {
  const f = fixture({ type: 'route_to_expert' }); let finish;
  f.submission = createSubmission({ state: f.state, client: { submit: () => new Promise(resolve => { finish = resolve; }) }, expertRouter: { dispatch: () => assert.fail('No new work after close') } });
  const submitted = f.submission.submit(f.args); f.submission.end(); finish({ ok: true, context_id: 'receipt', action: { type: 'route_to_expert' } });
  await submitted; assert.equal(f.state.report.contextId, 'receipt');
});

test('an expert failure cannot undo the external service submission receipt', async () => {
  const f = fixture();
  const submission = createSubmission({ state: f.state, client: { submit: async () => ({ ok: true, context_id: 'receipt', action: { type: 'route_to_expert', desk: 'maintenance', task_id: 'task' } }) }, expertRouter: { dispatch: async () => { throw new Error('Expert transport failed'); } } });
  const result = await submission.submit(f.args);
  assert.equal(result.ok, true); assert.equal(result.context_id, 'receipt'); assert.equal(f.state.report.delivery, 'recorded'); assert.equal(result.expert.status, 'unconfirmed');
});

test('undecided responses request another confirmed context round until the service decides', async () => {
 const f = fixture(); let rounds = 0;
 const submission = createSubmission({ state: f.state, client: { submit: async () => ({ ok: true, context_id: `receipt-${++rounds}`, outcome: rounds < 3 ? 'undecided' : 'solution', action: rounds < 3 ? null : { type: 'respond' } }) } });
 for (let round = 1; round <= 3; round++) {
  f.state.report.revision = `revision-${round}`;
  const result = await submission.submit({ ...f.args, report_revision: f.state.report.revision, context: `Caller confirmed additional detail ${round}` });
  assert.equal(result.reporter_next_step?.type, round < 3 ? 'gather_context' : undefined);
  await submission.submit({ ...f.args, report_revision: f.state.report.revision });
  assert.equal(rounds, round);
 }
});
