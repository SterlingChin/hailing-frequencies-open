import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { MemoryRepository } from './repo-memory.mjs';
import { createCallTools, CRM_TOOLS } from './tools.mjs';
import { createCRMService } from './service.mjs';
import { DEMO, seedDemo } from './seed.mjs';
import { NOW, PHONE } from './contract-tests.mjs';
import { lookupRepair } from '../voice/config.mjs';

async function fixture(t, scenario = 'fresh', lookup = lookupRepair) {
  const repo = new MemoryRepository();
  await seedDemo(repo, { scenario, phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const context = { callSid: 'fixture-tool-call', fromE164: PHONE, candidateIds: [], crewId: null, caseId: null };
  const tools = createCallTools({ service, context, lookupRepair: lookup });
  t.after(() => tools.end());
  await tools.ready;
  const load = () => tools.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  const open = async () => { await load(); return tools.handle('open_case', { equipment_id: DEMO.equipmentId, symptom: 'coffee arrives cold' }); };
  const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
  return { repo, tools, context, service, load, open, rows };
}
test('model tools have no crew/phone argument, and phone-only initialization discloses no profile', async t => {
  for (const tool of CRM_TOOLS) assert.doesNotMatch(JSON.stringify(tool.parameters), /crew_id|phone|fromE164/);
  const f = await fixture(t);
  assert.deepEqual(f.context.candidateIds, [DEMO.crewId]);
  assert.equal(f.context.crewId, null);
  assert.doesNotMatch(await f.tools.startupInstruction(), /Chen|Wayfinder|RPL|HF-038|12025550123/);
  assert.equal((await f.tools.handle('get_case_brief', {})).error.code, 'profile_required');
  assert.equal((await f.tools.handle('open_case', { equipment_id: DEMO.equipmentId, symptom: 'cold' })).error.code, 'profile_required');
  const loaded = await f.load();
  assert.equal(loaded.state, 'demo profile loaded');
  assert.equal(f.context.caseId, null);
  assert.doesNotMatch(JSON.stringify(loaded), /auth_code_hash|crewId|12025550123/);
});
for (const scenario of ['returning', 'two_open']) {
  test(`${scenario}: the tool asks before attaching a case`, async t => {
    const f = await fixture(t, scenario);
    const loaded = await f.load();
    assert.match(loaded.next_action, scenario === 'returning' ? /Ask whether/ : /Ask which/);
    assert.equal(loaded.open_cases.length, scenario === 'returning' ? 1 : 2);
    assert.equal(f.context.caseId, null);
    assert.equal((await f.tools.handle('resume_case', { case_id: 'HF-038' })).error.code, 'invalid_arguments');
    assert.equal((await f.tools.handle('resume_case', { case_id: 'HF-038', caller_confirmed: false })).error.code, 'invalid_arguments');
    assert.equal(f.context.caseId, null);
    assert.equal((await f.tools.handle('resume_case', { case_id: 'HF-038', caller_confirmed: true })).ok, true);
    assert.equal(f.context.caseId, 'HF-038');
    assert.match((await f.tools.handle('get_case_brief', {})).brief, /shipped via Subspace courier/);
  });
}
test('three attempts apply to concurrent tools and extra identity selectors are rejected', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.tools.handle('load_crew_profile', { spoken_code: 'wrong' })));
  assert.equal(results.at(-1).error.code, 'auth_attempt_limit');
  assert.equal((await f.load()).error.code, 'auth_attempt_limit');
  assert.equal((await f.tools.handle('load_crew_profile', { spoken_code: DEMO.authCode, crew_id: DEMO.crewId })).error.code, 'invalid_arguments');
  assert.equal((await f.tools.handle('get_case_brief', { case_id: 'HF-038' })).error.code, 'invalid_arguments');
});
test('another profile’s case cannot be resumed even with its known case ID', async t => {
  const f = await fixture(t, 'returning');
  await f.load();
  await f.repo.transaction(async tx => {
    const crew = (await tx.find('crew_members'))[0];
    const equipment = (await tx.find('equipment'))[0];
    const caseRecord = (await tx.find('cases'))[0];
    const otherCrewId = '10000000-0000-4000-8000-000000000001';
    const otherEquipmentId = '10000000-0000-4000-8000-000000000002';
    await tx.insert('crew_members', { ...crew, id: otherCrewId, display_name: 'Private person', auth_code_hash: 'f'.repeat(64) });
    await tx.insert('equipment', { ...equipment, id: otherEquipmentId, crew_member_id: otherCrewId });
    await tx.insert('cases', { ...caseRecord, id: 'HF-999', crew_member_id: otherCrewId, equipment_id: otherEquipmentId, title: 'Private title' });
  });
  const result = await f.tools.handle('resume_case', { case_id: 'HF-999', caller_confirmed: true });
  assert.equal(result.error.code, 'case_not_available');
  assert.equal(f.context.caseId, null);
  assert.doesNotMatch(JSON.stringify(result), /Private|HF-999/);
});
test('repair uses stored equipment/symptom and records its task; stale asynchronous work is preserved as obsolete', async t => {
  let resolveLookup, received;
  const f = await fixture(t, 'fresh', args => { received = args; return new Promise(resolve => { resolveLookup = resolve; }); });
  await f.open();
  const pending = f.tools.handle('lookup_repair', { equipment_model: 'RPL-7', symptom: 'an old symptom' });
  while (!resolveLookup) await tick();
  assert.deepEqual(received, { equipment_model: 'RPL-2400', symptom: 'coffee arrives cold' });
  assert.equal((await f.rows('specialist_tasks'))[0].status, 'working');
  await f.tools.handle('update_symptom', { symptom: 'tea is cold too' });
  resolveLookup(lookupRepair(received));
  assert.equal((await pending).error.code, 'obsolete_result');
  const task = (await f.rows('specialist_tasks'))[0];
  assert.equal(task.status, 'obsolete'); assert.ok(task.result.diagnosis);
  assert.equal((await f.rows('cases'))[0].diagnosis, null);
});
test('end persists call_ended while independent specialist work can complete', async t => {
  let resolveLookup;
  const f = await fixture(t, 'fresh', () => new Promise(resolve => { resolveLookup = resolve; }));
  await f.open();
  const pending = f.tools.handle('lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' });
  while (!resolveLookup) await tick();
  await f.tools.end();
  assert.equal((await f.rows('specialist_tasks'))[0].status, 'working');
  assert.equal((await f.rows('case_events', { kind: 'call_ended' })).length, 1);
  resolveLookup(lookupRepair({ equipment_model: 'RPL-2400', symptom: 'cold' }));
  assert.equal((await pending).ok, true);
  assert.equal((await f.rows('cases'))[0].status, 'open');
  assert.equal((await f.tools.handle('update_symptom', { symptom: 'new' })).error.code, 'interaction_ended');
});
test('database-down tools expose only a safe memory error; catalog repairs still work', async () => {
  const service = createCRMService({ transaction() { throw new Error('private-database-secret-sentinel'); } });
  const tools = createCallTools({ service, context: { callSid: 'down-call', fromE164: PHONE }, lookupRepair });
  assert.equal(await tools.ready, false);
  assert.match(await tools.startupInstruction(), /can't reach case records/);
  const result = await tools.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  assert.equal(result.error.code, 'memory_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private-database|Chen|Wayfinder/);
  const repair = await tools.handle('lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' });
  assert.equal(repair.ok, true); assert.equal(repair.memory.error.code, 'memory_unavailable');
  await tools.end();
});
test('failed catalog work becomes a failed task, with no invented diagnosis', async t => {
  const f = await fixture(t, 'fresh', () => { throw new Error('private catalog exception'); });
  await f.open();
  const result = await f.tools.handle('lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' });
  assert.equal(result.error.code, 'repair_lookup_failed');
  assert.equal((await f.rows('specialist_tasks'))[0].status, 'failed');
  assert.equal((await f.rows('cases'))[0].diagnosis_status, 'none');
});

test('route_request queues through the decision step, request_reply binds consent to the signed number, and a return call reveals its result only to the matching profile', async t => {
  const repo = new MemoryRepository();
  await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const evaluations = [], queued = [];
  const decisionStep = { enabled: true, evaluate: async args => { evaluations.push(args);
    const context = await service.getInteractionContext({ interactionId: args.interactionId, request: args.request });
    const saved = await service.applyRoutingDecision({ interactionId: args.interactionId, context, outcome: 'queue', specialist: 'it', assignment: `elevated: ${args.request}` });
    return { outcome: 'queue', reason: 'route_it', route: 'it', urgencyLabel: 'elevated', ...saved }; } };
  const context = { callSid: 'fixture-route-call', fromE164: PHONE, candidateIds: [], crewId: null, caseId: null, profile: null, callbackTaskId: null };
  const tools = createCallTools({ service, context, lookupRepair, decisionStep, onQueued: id => queued.push(id) });
  t.after(() => tools.end()); await tools.ready;
  assert.equal((await tools.handle('route_request', { request: 'help' })).error.code, 'profile_required');
  await tools.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  assert.ok(context.profile?.ship);
  assert.equal((await tools.handle('route_request', { request: 'help' })).error.code, 'case_required');
  await tools.handle('open_case', { equipment_id: DEMO.equipmentId, symptom: 'cannot open the science report' });
  for (const args of [{}, { request: '' }, { request: 'x'.repeat(501) }, { request: 'ok', extra: true }]) assert.equal((await tools.handle('route_request', args)).error.code, 'invalid_arguments');
  const routed = await tools.handle('route_request', { request: 'I cannot open the science report that was due' });
  assert.equal(routed.outcome, 'queue'); assert.equal(routed.route, 'it'); assert.equal(routed.action.type, 'route_to_expert');
  assert.deepEqual(JSON.parse(routed.action.tool_call.arguments.context), routed.context);
  assert.match(routed.task_id, /^[0-9a-f-]{36}$/); assert.deepEqual(queued, []);
  assert.equal(evaluations[0].profile, context.profile); assert.doesNotMatch(JSON.stringify(evaluations[0]), /12025550123/);
  const reply = { task_id: routed.task_id, channel: 'sms', caller_requested: true, caller_confirmed_destination: true };
  for (const args of [{ ...reply, caller_requested: false }, { ...reply, caller_confirmed_destination: false }, { ...reply, channel: 'screen' }, { ...reply, task_id: 'not-a-uuid' }, { ...reply, to: '+12025550199' }]) {
    assert.equal((await tools.handle('request_reply', args)).ok, false);
  }
  const consented = await tools.handle('request_reply', reply);
  assert.equal(consented.ok, true); assert.equal(consented.channel, 'sms'); assert.match(consented.message, /Check the recorded outcome/);
  const stored = (await repo.transaction(tx => tx.find('specialist_tasks', { id: routed.task_id })))[0];
  assert.equal(stored.reply_channel, 'sms'); assert.ok(stored.reply_contact_point_id);
  await tools.end();
  await service.recordTaskResult({ taskId: routed.task_id, result: { summary: 'Clearance lapsed at transfer; 24-hour pass issued.' } });

  // Return call: the welcome asks for the phrase first; the result appears only after the right profile loads.
  const back = { callSid: 'fixture-return-call', fromE164: PHONE, candidateIds: [], crewId: null, caseId: null, profile: null, callbackTaskId: routed.task_id };
  const returning = createCallTools({ service, context: back, lookupRepair, decisionStep });
  t.after(() => returning.end()); await returning.ready;
  assert.equal((await repo.transaction(tx => tx.find('interactions', { provider_sid: 'fixture-return-call' })))[0].direction, 'outbound');
  assert.doesNotMatch(await returning.startupInstruction(), /Clearance|HF-/);
  const loaded = await returning.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  assert.equal(loaded.callback.matched, true); assert.match(loaded.callback.result, /Clearance lapsed/); assert.match(loaded.next_action, /return call about case HF-\d+/);
  const stranger = { callSid: 'fixture-wrong-profile', fromE164: PHONE, candidateIds: [], crewId: null, caseId: null, profile: null, callbackTaskId: '00000000-0000-4000-8000-00000000dead' };
  const wrong = createCallTools({ service, context: stranger, lookupRepair });
  t.after(() => wrong.end()); await wrong.ready;
  const unmatched = await wrong.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  assert.deepEqual(unmatched.callback, { matched: false });
  // The authorized profile may include its own case history; an unmatched
  // callback must not reveal a callback result or claim the task belongs to it.
  assert.match(unmatched.next_action, /not for the loaded profile/);
});
