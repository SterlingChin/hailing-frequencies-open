import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { DEMO, seedDemo } from '../crm/seed.mjs';
import { NOW, PHONE } from '../crm/contract-tests.mjs';
import { createDecisionStep } from './step.mjs';

const answers = ({ route = 'it', confidence = 0.9, resolvable = 0.1, details = 0.1 } = {}) => [
  { type: 'choice', name: 'route', choice: route, confidence, probabilities: [] },
  { type: 'predicate', name: 'resolvable_now', probability: resolvable },
  { type: 'predicate', name: 'needs_more_details', probability: details },
  { type: 'score', name: 'urgency', score: 1, confidence: 0.8, probabilities: [{ value: 1, label: 'elevated', probability: 0.9 }] },
];
async function fixture(decide) {
  const repo = new MemoryRepository(); await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const i = await service.beginInteraction({ providerSid: 'decision-fixture' });
  const loaded = await service.loadProfileByAuthCode({ spokenCode: DEMO.authCode, interactionId: i.id });
  const inputs = [];
  const client = { enabled: true, decide: async args => { inputs.push(args); return decide(args); } };
  const step = createDecisionStep({ service, client });
  return { repo, service, i, profile: loaded.profile, step, inputs, rows: (table, where = {}) => repo.transaction(tx => tx.find(table, where)) };
}

test('queue outcome starts a task on the selected case with the route and urgency; the bundle carries no phone number', async () => {
  const f = await fixture(async () => ({ ok: true, answers: answers(), usage: { input_tokens: 10 } }));
  await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'cannot open the science report' });
  const decision = await f.step.evaluate({ interactionId: f.i.id, profile: f.profile, request: 'I cannot open the science report that was due; text me at +12025550123' });
  assert.equal(decision.outcome, 'queue'); assert.equal(decision.route, 'it'); assert.equal(decision.urgencyLabel, 'elevated');
  assert.equal(decision.task.specialist, 'it'); assert.match(decision.task.assignment, /^elevated: I cannot open/);
  assert.equal(decision.hasSelectedCase, true); assert.equal(decision.identified, true);
  assert.equal(f.inputs.length, 1); assert.doesNotMatch(f.inputs[0].input, /12025550123|A7B9E2/); assert.match(f.inputs[0].input, /Commander Avery Chen, USS Wayfinder/);
  assert.match(f.inputs[0].safetyIdentifier, /^[a-f0-9]{32}$/);
  assert.equal((await f.rows('specialist_tasks'))[0].status, 'working');
});
test('other outcomes queue nothing; provider failure and a missing case are reported, never thrown', async () => {
  const solution = await fixture(async () => ({ ok: true, answers: answers({ route: 'none', resolvable: 0.9 }) }));
  await solution.service.openCase({ interactionId: solution.i.id, equipmentId: DEMO.equipmentId, symptom: 'coffee cold' });
  assert.equal((await solution.step.evaluate({ interactionId: solution.i.id, profile: solution.profile, request: 'coffee is cold' })).reason, 'stored_solution_unavailable');
  assert.equal((await solution.rows('specialist_tasks')).length, 0);
  const noCase = await fixture(async () => ({ ok: true, answers: answers() }));
  const undecided = await noCase.step.evaluate({ interactionId: noCase.i.id, profile: noCase.profile, request: 'help' });
  assert.equal(undecided.outcome, 'undecided'); assert.equal(undecided.reason, 'case_required'); assert.equal(undecided.hasSelectedCase, false);
  const failing = await fixture(async () => ({ ok: false, error: { code: 'decisions_http', status: 500 } }));
  await failing.service.openCase({ interactionId: failing.i.id, equipmentId: DEMO.equipmentId, symptom: 'coffee cold' });
  assert.deepEqual((await failing.step.evaluate({ interactionId: failing.i.id, profile: failing.profile, request: 'help' })).reason, 'decisions_http');
  const disabled = createDecisionStep({ service: null, client: { enabled: false } });
  assert.equal(disabled.enabled, false);
  assert.equal((await disabled.evaluate({ request: 'help' })).reason, 'decisions_unavailable');
});

for (const route of ['it', 'maintenance']) {
  test(`${route}: the same fresh CRM context reaches Decisions, Live's result, and the persisted specialist handoff`, async () => {
    const f = await fixture(async () => ({ ok: true, answers: answers({ route }) }));
    await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'Report will not open' });
    const decision = await f.step.evaluate({ interactionId: f.i.id, profile: { display_name: 'Untrusted cached profile' }, request: 'Please help with this report' });
    assert.equal(decision.route, route); assert.equal(decision.reused, false);
    assert.ok(f.inputs[0].input.startsWith(decision.context.text));
    assert.match(f.inputs[0].input, /expert_engineering.*it.*maintenance/);
    const { text, ...data } = decision.context;
    assert.ok(text.includes(JSON.stringify(data)), 'all shared CRM fields reach the classifier');
    assert.equal(decision.context.profile.display_name, 'Avery Chen');
    assert.deepEqual((await f.service.getTaskAssignment(decision.task.id)).context, decision.context);
    assert.doesNotMatch(JSON.stringify(decision.context), /auth_code|A7B9E2|12025550123|contact_point|reply_contact/);
    await f.service.endInteraction(f.i.id);
    assert.deepEqual((await f.service.getTaskAssignment(decision.task.id)).context, decision.context, 'handoff survives the initial call');
  });
}

test('a completed current answer is returned to Live without a new task; a caller-rejected answer is not reusable', async () => {
  const f = await fixture(async () => ({ ok: true, answers: answers({ route: 'none', resolvable: 0.9 }) }));
  await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'coffee cold' });
  const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'repair coffee' });
  await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Thermal setting was low.', next_step: 'Set the temperature to hot.' } });
  const solved = await f.step.evaluate({ interactionId: f.i.id, request: 'What did Maintenance find?' });
  assert.equal(solved.outcome, 'solution'); assert.equal(solved.task, null); assert.equal(solved.reused, true);
  assert.equal(solved.solution.task_id, task.id); assert.equal(solved.solution.confirmed_fixed, false);
  assert.match(f.inputs[0].input, /Set the temperature to hot/);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
  await f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'not_fixed', callerConfirmed: true });
  const rejected = await f.step.evaluate({ interactionId: f.i.id, request: 'That did not fix it' });
  assert.equal(rejected.outcome, 'undecided'); assert.equal(rejected.reason, 'stored_solution_unavailable');
  assert.equal(rejected.context.selected_case.solution, null);
});

test('racing classifications reuse one pending task and preserve its original context snapshot', async () => {
  const f = await fixture(async () => ({ ok: true, answers: answers() }));
  await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'Report will not open' });
  const results = await Promise.all(['First request', 'Second request'].map(request => f.step.evaluate({ interactionId: f.i.id, request })));
  assert.equal(results[0].task.id, results[1].task.id);
  assert.equal(results.filter(r => r.reused).length, 1);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
  assert.equal((await f.rows('case_events', { kind: 'task_started' })).length, 1);
  const created = results.find(r => !r.reused);
  assert.deepEqual((await f.service.getTaskAssignment(created.task.id)).context, created.context);
});

test('a symptom change while Decisions runs invalidates its answer without queuing or retrying', async () => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await fixture(async () => { started.resolve(); await pending.promise; return { ok: true, answers: answers() }; });
  await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'Report will not open' });
  const response = f.step.evaluate({ interactionId: f.i.id, request: 'Report will not open' });
  await started.promise;
  await f.service.updateSymptom({ interactionId: f.i.id, symptom: 'The display is physically cracked' });
  pending.resolve();
  assert.equal((await response).reason, 'context_changed');
  assert.equal((await f.rows('specialist_tasks')).length, 0); assert.equal(f.inputs.length, 1);
});

test('a solved closed case can be reviewed without reopening it or dispatching another specialist', async () => {
  const f = await fixture(async () => ({ ok: true, answers: answers({ route: 'none', resolvable: 0.9 }) }));
  const c = await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'coffee cold' });
  const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'repair' });
  await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Setting corrected.', next_step: 'Use the hot setting.' } });
  await f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'confirmed_fixed', callerConfirmed: true });
  await f.service.closeCase({ interactionId: f.i.id, callerConfirmed: true });
  await f.service.endInteraction(f.i.id);
  const returning = await f.service.beginInteraction({ providerSid: 'returning-solved' });
  const loaded = await f.service.loadProfileByAuthCode({ spokenCode: DEMO.authCode, interactionId: returning.id });
  assert.equal(loaded.profile.open_cases.length, 0); assert.equal(loaded.profile.recent_cases[0].caseId, c.caseId);
  await f.service.attachInteraction({ interactionId: returning.id, caseId: c.caseId, callerConfirmed: true, reviewOnly: true });
  const decision = await f.step.evaluate({ interactionId: returning.id, request: 'Remind me of the fix' });
  assert.equal(decision.outcome, 'solution'); assert.equal(decision.solution.confirmed_fixed, true);
  assert.equal((await f.rows('cases'))[0].status, 'closed'); assert.equal((await f.rows('specialist_tasks')).length, 1);
});
