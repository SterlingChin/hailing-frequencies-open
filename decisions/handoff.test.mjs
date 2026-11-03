import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { createCallTools } from '../crm/tools.mjs';
import { seedDemo, DEMO } from '../crm/seed.mjs';
import { NOW, PHONE } from '../crm/contract-tests.mjs';
import { createDecisionStep } from './step.mjs';
import { createCallReply } from '../reply/call.mjs';

for (const desk of ['it', 'maintenance']) test(`${desk}: Live tools share context, reuse pending work, and return a closed solution without dispatch`, async t => {
  const repo = new MemoryRepository();
  await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const inputs = [], dispatched = [];
  let solved = false;
  const decisionStep = createDecisionStep({ service, client: { enabled: true, async decide({ input }) {
    inputs.push(input);
    return { ok: true, answers: [
      { name: 'route', type: 'choice', choice: solved ? 'none' : desk, confidence: 0.99 },
      { name: 'resolvable_now', type: 'predicate', probability: solved ? 0.99 : 0.01 },
      { name: 'needs_more_details', type: 'predicate', probability: 0.01 },
      { name: 'urgency', type: 'score', score: 0, probabilities: [{ label: 'routine', probability: 1 }] },
    ] };
  } } });
  const calls = id => createCallTools({ service, context: { callSid: id, fromE164: PHONE }, decisionStep,
    onQueued: taskId => dispatched.push(taskId) });
  const tools = calls(`first-${desk}`); t.after(() => tools.end());
  assert.equal((await tools.handle('get_crm_context', {})).error.code, 'profile_required');
  const loaded = await tools.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  assert.equal(loaded.crm_context.profile.display_name, 'Avery Chen');
  assert.equal(loaded.crm_context.selected_case, null);
  const opened = await tools.handle('open_case', { equipment_id: DEMO.equipmentId, symptom: 'The report display will not open' });
  const routed = await tools.handle('route_request', { request: 'The report display will not open' });
  assert.equal(routed.route, desk); assert.equal(routed.callback_owner, desk);
  assert.ok(inputs[0].startsWith(routed.context.text));
  assert.equal(routed.action.type, 'route_to_expert');
  assert.equal(routed.action.tool_call.name, 'expert_engineering');
  assert.deepEqual(JSON.parse(routed.action.tool_call.arguments.context), routed.context);
  assert.deepEqual((await service.getTaskAssignment(routed.task_id)).context, routed.crm_context);
  const pending = await tools.handle('route_request', { request: 'What is happening with my report?' });
  assert.equal(pending.task_id, routed.task_id); assert.equal(pending.reused, true);
  assert.equal(pending.action.dispatch_policy, 'reconcile_existing');
  assert.deepEqual(pending.action.tool_call, routed.action.tool_call);
  assert.deepEqual(dispatched, []);
  const consent = await tools.handle('request_reply', { task_id: routed.task_id, channel: 'voice', caller_requested: true, caller_confirmed_destination: true });
  assert.equal(consent.callback_owner, desk);
  await service.recordTaskResult({ taskId: routed.task_id, result: { summary: 'The display setting has been corrected.', next_step: 'Reopen the report.' } });
  // Our legacy callback goes through the reporting agent, so these new desks
  // must leave consent/results available for Michael's specialist integration.
  let reportingCalls = 0;
  const reply = createCallReply({ service, config: { callbackEnabled: true },
    place: async () => { reportingCalls++; return { sid: `CA${'1'.repeat(32)}` }; },
    registerCallback: () => { throw new Error('Must not use the reporting bridge'); } });
  assert.equal((await reply.deliver({ taskId: routed.task_id })).status, 'unavailable');
  assert.equal(reportingCalls, 0);
  assert.deepEqual((await service.listRepliesDue()).map(r => r.id), [routed.task_id]);
  solved = true;
  const answer = await tools.handle('route_request', { request: 'What did the specialist find?' });
  assert.equal(answer.outcome, 'solution'); assert.equal(answer.task_id, null);
  assert.equal(answer.solution.result.next_step, 'Reopen the report.'); assert.equal(answer.solution.confirmed_fixed, false);
  assert.equal((await tools.handle('record_repair_outcome', { outcome: 'confirmed_fixed', caller_confirmed: true })).ok, true);
  assert.equal((await tools.handle('close_case', { caller_confirmed: true })).ok, true);
  await tools.end();
  const returning = calls(`return-${desk}`); t.after(() => returning.end());
  const profile = await returning.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  assert.equal(profile.crm_context.profile.recent_cases[0].caseId, opened.caseId);
  assert.equal((await returning.handle('review_case', { case_id: opened.caseId, caller_confirmed: false })).ok, false);
  assert.equal((await returning.handle('review_case', { case_id: opened.caseId, caller_confirmed: true })).ok, true);
  const reused = await returning.handle('route_request', { request: 'Remind me what solved this issue' });
  assert.equal(reused.action.type, 'respond');
  assert.equal(reused.outcome, 'solution'); assert.equal(reused.solution.confirmed_fixed, true);
  assert.equal(reused.crm_context.selected_case.status, 'closed');
  assert.deepEqual(dispatched, []);
  assert.equal((await repo.transaction(tx => tx.find('specialist_tasks'))).length, 1);
  assert.doesNotMatch(JSON.stringify(reused.crm_context), /auth_code|A7B9E2|12025550123|reply_contact/);
});
