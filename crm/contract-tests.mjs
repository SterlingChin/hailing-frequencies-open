import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCRMService, hashAuthCode } from './service.mjs';
import { DEMO, seedDemo } from './seed.mjs';
import { ROSTER, seedRoster } from './roster.mjs';

export const NOW = new Date('2026-10-11T18:00:00Z');
export const PHONE = '+12025550123';
export async function fixture(repo, scenario = 'fresh') {
  await seedDemo(repo, { scenario, phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const i = await service.beginInteraction({ providerSid: `test-${randomUUID()}` });
  const load = () => service.loadProfileByAuthCode({ spokenCode: 'Authorization, Chen, Avery, Alpha seven, Bravo nine, Echo two', candidateIds: [], interactionId: i.id });
  const open = async () => { await load(); return service.openCase({ interactionId: i.id, equipmentId: DEMO.equipmentId, symptom: 'coffee arrives cold' }); };
  const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
  return { repo, service, i, load, open, rows };
}

export function repositoryContract(label, makeRepo) {
  const scenarioTest = (name, run) => test(`${label}: ${name}`, async t => {
    const repo = await makeRepo(t);
    await run(await fixture(repo), t);
  });
  scenarioTest('general support intake persists without equipment and reuses only an exact full-text request', async f => {
    const body = 'I need access to my own personal logs.';
    async function intake(blob) {
      const receipt = await f.service.recordReporterContext({ crewMemberId: DEMO.crewId, blob });
      const context = await f.service.getReporterContext({ crewMemberId: DEMO.crewId, contextId: receipt.id });
      return f.service.applyReporterDecision({ context, outcome: 'queue', specialist: 'it', issue: 'new:unassigned', urgencyLabel: 'routine' });
    }
    const first = await intake(body), repeated = await intake(body);
    assert.equal(first.context.selected_case.equipment_id, null);
    assert.equal(repeated.task.id, first.task.id); assert.equal(repeated.reused, true);
    assert.deepEqual(repeated.task.context_snapshot, first.context);
    const assignment = await f.service.getTaskAssignment(first.task.id);
    assert.equal(assignment.equipment_model, null); assert.equal(assignment.equipment_location, null);
    await f.load();
    await f.service.attachInteraction({ interactionId: f.i.id, caseId: first.task.case_id, callerConfirmed: true });
    assert.equal((await f.service.startTask({ interactionId: f.i.id, specialist: 'it', assignment: 'Review personal-log access' })).equipment_model, null);
    // A shared display preview is not an identity key for two different issues.
    const prefix = 'Shared conversation context. '.repeat(20);
    const a = await intake(prefix + 'Personal logs.'), b = await intake(prefix + 'Ship-wide classified records.');
    assert.notEqual(a.context.selected_case.id, b.context.selected_case.id);
    assert.equal((await f.rows('equipment')).length, 1);
  });
  test(`${label}: Avery's production seed preserves existing history and rotates only the old phrase`, async t => {
    const repo = await makeRepo(t);
    assert.deepEqual(await seedDemo(repo, { scenario: 'returning', phone: PHONE, now: NOW, preserveExisting: true }), { scenario: 'returning', added: true, phraseUpdated: false });
    const before = await repo.transaction(async tx => ({
      crew: await tx.find('crew_members', { id: DEMO.crewId }),
      cases: await tx.find('cases', { crew_member_id: DEMO.crewId }),
      interactions: await tx.find('interactions', { crew_member_id: DEMO.crewId }),
    }));
    assert.deepEqual(await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: NOW, preserveExisting: true }), { scenario: 'fresh', added: false, phraseUpdated: false });
    const after = await repo.transaction(async tx => ({
      crew: await tx.find('crew_members', { id: DEMO.crewId }),
      cases: await tx.find('cases', { crew_member_id: DEMO.crewId }),
      interactions: await tx.find('interactions', { crew_member_id: DEMO.crewId }),
    }));
    assert.deepEqual(after, before);
    await repo.transaction(tx => tx.update('crew_members', DEMO.crewId, { auth_code_hash: hashAuthCode('CHEN-AVERY-A484B7') }));
    assert.deepEqual(await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: NOW, preserveExisting: true }), { scenario: 'fresh', added: false, phraseUpdated: true });
    const rotated = await repo.transaction(tx => tx.find('crew_members', { id: DEMO.crewId }));
    assert.equal(rotated[0].auth_code_hash, hashAuthCode(DEMO.authCode));
    assert.deepEqual(await repo.transaction(tx => tx.find('cases', { crew_member_id: DEMO.crewId })), before.cases);
  });
  scenarioTest('shared CRM context requires identity and persists the same safe snapshot on one deduplicated task', async f => {
    await assert.rejects(() => f.service.getInteractionContext({ interactionId: f.i.id }), { code: 'profile_required' });
    const c = await f.open();
    const context = await f.service.getInteractionContext({ interactionId: f.i.id, request: 'Please help; call +1 (202) 555-0123' });
    assert.equal(context.selected_case.id, c.caseId); assert.equal(context.profile.display_name, 'Avery Chen');
    assert.equal(context.profile.preferred_language, 'english');
    assert.doesNotMatch(JSON.stringify(context), /auth_code|A7B9E2|555-0123|12025550123|contact_point/);
    assert.equal(context.selected_case.solution, null);
    const args = { interactionId: f.i.id, context, outcome: 'queue', specialist: 'it', assignment: 'routine: report will not open' };
    const results = await Promise.all([f.service.applyRoutingDecision(args), f.service.applyRoutingDecision(args)]);
    assert.equal(results[0].task.id, results[1].task.id); assert.equal(results.filter(r => r.reused).length, 1);
    const task = (await f.rows('specialist_tasks'))[0]; assert.deepEqual(task.context_snapshot, context);
    assert.deepEqual((await f.service.getTaskAssignment(task.id)).context, context);
    await f.repo.transaction(tx => tx.update('crew_members', DEMO.crewId, { posting: 'New posting' }));
    assert.equal((await f.service.getInteractionContext({ interactionId: f.i.id })).profile.posting, 'New posting');
    await f.service.endInteraction(f.i.id);
    assert.deepEqual((await f.service.getTaskAssignment(task.id)).context, context, 'original specialist argument survives subsequent profile changes and hang-up');
    assert.equal((await f.rows('case_events', { kind: 'task_started' })).length, 1);
  });
  scenarioTest('stored solutions require a current successful answer; symptom changes and rejected findings cannot be reused', async f => {
    await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'it', assignment: 'report access' });
    await f.service.recordTaskResult({ taskId: task.id, result: { summary: 'Use the updated report link.', source_id: 'fictional-it' } });
    const context = await f.service.getInteractionContext({ interactionId: f.i.id, request: 'What is the answer?' });
    const reused = await f.service.applyRoutingDecision({ interactionId: f.i.id, context, outcome: 'solution' });
    assert.equal(reused.solution.task_id, task.id); assert.equal(reused.solution.confirmed_fixed, false); assert.equal(reused.task, null);
    assert.equal((await f.rows('specialist_tasks')).length, 1);
    await f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'not_fixed', callerConfirmed: true });
    assert.equal((await f.service.getInteractionContext({ interactionId: f.i.id })).selected_case.solution, null, 'IT summary-only answers can also be rejected by the caller');
    await f.service.updateSymptom({ interactionId: f.i.id, symptom: 'The screen is now cracked' });
    assert.equal((await f.service.getInteractionContext({ interactionId: f.i.id })).selected_case.solution, null);
    await assert.rejects(() => f.service.applyRoutingDecision({ interactionId: f.i.id, context, outcome: 'solution' }), { code: 'context_changed' });
    const failed = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'screen' });
    await f.service.recordTaskResult({ taskId: failed.id, failed: true, result: { summary: 'No fix available.' } });
    assert.equal((await f.service.getInteractionContext({ interactionId: f.i.id })).selected_case.solution, null);
    const fresh = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'screen diagnosis' });
    await f.service.recordTaskResult({ taskId: fresh.id, result: { diagnosis: 'Loose connection.', next_step: 'Reseat it.' } });
    const beforeRejection = await f.service.getInteractionContext({ interactionId: f.i.id });
    await f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'not_fixed', callerConfirmed: true });
    await assert.rejects(() => f.service.applyRoutingDecision({ interactionId: f.i.id, context: beforeRejection, outcome: 'solution' }), { code: 'context_changed' });
    const rejected = await f.service.getInteractionContext({ interactionId: f.i.id });
    assert.equal(rejected.selected_case.solution, null);
    await assert.rejects(() => f.service.applyRoutingDecision({ interactionId: f.i.id, context: rejected, outcome: 'solution' }), { code: 'stored_solution_unavailable' });
  });
  scenarioTest('closed solutions can be reviewed with confirmation and remain closed; new work gets a new case', async f => {
    const c = await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'repair' });
    await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Setting corrected.', next_step: 'Use the hot setting.' } });
    await f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'confirmed_fixed', callerConfirmed: true });
    await f.service.closeCase({ interactionId: f.i.id, callerConfirmed: true }); await f.service.endInteraction(f.i.id);
    const next = await f.service.beginInteraction({ providerSid: `review-${randomUUID()}` });
    const loaded = await f.service.loadProfileByAuthCode({ spokenCode: DEMO.authCode, interactionId: next.id });
    assert.equal(loaded.profile.recent_cases[0].caseId, c.caseId);
    const args = { interactionId: next.id, caseId: c.caseId, reviewOnly: true };
    assert.throws(() => f.service.attachInteraction(args), { code: 'confirmation_required' });
    await f.service.attachInteraction({ ...args, callerConfirmed: true });
    const context = await f.service.getInteractionContext({ interactionId: next.id, request: 'Remind me of the solution' });
    const result = await f.service.applyRoutingDecision({ interactionId: next.id, context, outcome: 'solution' });
    assert.equal(result.solution.confirmed_fixed, true); assert.equal((await f.rows('cases', { id: c.caseId }))[0].status, 'closed');
    await assert.rejects(() => f.service.applyRoutingDecision({ interactionId: next.id, context, outcome: 'queue', specialist: 'it', assignment: 'new work' }), { code: 'case_closed' });
    const newCase = await f.service.openCase({ interactionId: next.id, equipmentId: DEMO.equipmentId, symptom: 'A different problem' });
    assert.notEqual(newCase.caseId, c.caseId);
    await assert.rejects(() => f.service.applyRoutingDecision({ interactionId: next.id, context, outcome: 'solution' }), { code: 'context_changed' });
  });
  scenarioTest('phone hints reveal only IDs; phrase loads a profile with no contacts or hash', async f => {
    assert.deepEqual(await f.service.findCandidatesByPhone(PHONE), [DEMO.crewId]);
    assert.deepEqual(await f.service.findCandidatesByPhone('anonymous'), []);
    const before = (await f.rows('interactions', { id: f.i.id }))[0];
    assert.equal(before.crew_member_id, null); assert.equal(before.case_id, null);
    const loaded = await f.load();
    assert.equal(loaded.ok, true); assert.equal(loaded.profile.ship, 'USS Wayfinder');
    assert.equal(loaded.profile.equipment[0].model, 'RPL-2400');
    assert.doesNotMatch(JSON.stringify(loaded.profile), /auth_code_hash|contact_points|12025550123/);
    assert.equal((await f.rows('outbound_messages')).length, 0);
    const e = (await f.rows('case_events'))[0];
    assert.equal(e.kind, 'profile_loaded'); assert.equal(e.case_id, null);
    assert.doesNotMatch(JSON.stringify(e), /A7B9E2|Alpha seven|auth_code/);
  });
  scenarioTest('concurrent wrong phrases consume exactly three attempts; no fourth attempt succeeds', async f => {
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => f.service.loadProfileByAuthCode({ spokenCode: 'wrong', interactionId: f.i.id })));
    assert.equal(outcomes.filter(r => r.error.code === 'profile_not_found').length, 3);
    assert.equal(outcomes.filter(r => r.error.code === 'auth_attempt_limit').length, 2);
    assert.equal((await f.load()).error.code, 'auth_attempt_limit');
    assert.equal((await f.rows('case_events')).length, 0);
  });
  scenarioTest('separate name and authorization match one record before identity or profile events are saved', async f => {
    for (const spokenCode of ['Alpha seven, Bravo nine, Echo two', DEMO.authCode]) {
      const result = await f.service.loadProfileByAuthCode({ name: 'Someone Else', spokenCode, interactionId: f.i.id, demoOnly: true });
      assert.deepEqual(result, { ok: false, error: { code: 'profile_not_found' } });
      assert.equal((await f.rows('interactions', { id: f.i.id }))[0].crew_member_id, null);
      assert.equal((await f.rows('case_events', { kind: 'profile_loaded' })).length, 0);
    }
    const loaded = await f.service.loadProfileByAuthCode({ name: '  AVERY   chen ', spokenCode: 'Alpha seven, Bravo nine, Echo two', interactionId: f.i.id, demoOnly: true });
    assert.equal(loaded.ok, true); assert.equal(loaded.crewId, DEMO.crewId);
    assert.equal((await f.rows('case_events', { kind: 'profile_loaded' })).length, 1);
    assert.doesNotMatch(JSON.stringify(loaded.profile), /auth_code_hash|A7B9E2|Alpha seven/);
  });
  scenarioTest('fresh case starts at HF-042; repeat interaction and case resume are idempotent', async f => {
    assert.equal((await f.service.beginInteraction({ providerSid: f.i.provider_sid })).id, f.i.id);
    await assert.rejects(() => f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'cold' }), { code: 'profile_required' });
    const c = await f.open(); assert.equal(c.caseId, 'HF-042');
    await Promise.all([1, 2].map(() => f.service.attachInteraction({ interactionId: f.i.id, caseId: c.caseId, callerConfirmed: true })));
    assert.equal((await f.rows('cases')).length, 1);
    assert.equal((await f.rows('case_events', { kind: 'profile_loaded' }))[0].case_id, c.caseId);
    await assert.rejects(() => f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'cold' }), { code: 'case_already_selected' });
  });
  scenarioTest('returning/two_open seeds are repeatable, relative and contain stored shipment facts', async f => {
    for (const scenario of ['returning', 'two_open', 'fresh', 'returning']) {
      await seedDemo(f.repo, { scenario, phone: PHONE, now: NOW });
      const cases = await f.service.listOpenCases(DEMO.crewId);
      assert.equal(cases.length, scenario === 'fresh' ? 0 : scenario === 'two_open' ? 2 : 1);
      if (cases.length) {
        const brief = await f.service.getCaseBrief('HF-038');
        assert.ok(brief.length <= 600);
        for (const fact of ['last week', 'not_fixed', 'shipped', 'Subspace courier', 'tomorrow', 'delivered']) assert.ok(brief.includes(fact), fact);
      }
    }
    assert.equal((await f.rows('equipment'))[0].last_service_at, '2026-09-27T18:00:00.000Z');
  });
  scenarioTest('resume requires caller confirmation and restricts case/equipment/contact ownership', async f => {
    await f.load();
    const otherId = randomUUID(), equipmentId = randomUUID(), contactId = randomUUID();
    await f.repo.transaction(async tx => {
      await tx.insert('crew_members', { id: otherId, display_name: 'Other crew', rank: 'Ensign', ship: 'Other ship', language: 'English', auth_code_hash: hashAuthCode('OTHER-CREW-A123B4'), is_demo: false, created_at: NOW.toISOString() });
      await tx.insert('equipment', { id: equipmentId, crew_member_id: otherId, model: 'Private model', location: 'Other deck', last_service_at: null, last_service_note: null });
      await tx.insert('contact_points', { id: contactId, crew_member_id: otherId, kind: 'phone', value: PHONE, label: 'Shared phone', created_at: NOW.toISOString() });
      await tx.insert('cases', { id: 'HF-500', crew_member_id: otherId, equipment_id: equipmentId, status: 'open', title: 'Private title', symptom: 'Private symptom', symptom_revision: 1, diagnosis: null, diagnosis_status: 'none', next_step: null, opened_at: NOW.toISOString(), updated_at: NOW.toISOString(), resolved_at: null });
    });
    assert.equal((await f.service.findCandidatesByPhone(PHONE)).length, 2);
    assert.throws(() => f.service.attachInteraction({ interactionId: f.i.id, caseId: 'HF-500' }), { code: 'confirmation_required' });
    await assert.rejects(() => f.service.attachInteraction({ interactionId: f.i.id, caseId: 'HF-500', callerConfirmed: true }), { code: 'case_not_available' });
    await assert.rejects(() => f.service.openCase({ interactionId: f.i.id, equipmentId, symptom: 'cold' }), { code: 'equipment_not_available' });
    await f.service.openCase({ interactionId: f.i.id, equipmentId: DEMO.equipmentId, symptom: 'cold' });
    await assert.rejects(() => f.service.requestMessage({ interactionId: f.i.id, contactPointId: contactId, body: 'hello', idempotencyKey: 'private-contact', explicitRequest: true }), { code: 'contact_not_available' });
    await seedDemo(f.repo, { scenario: 'fresh', phone: PHONE, now: NOW });
    assert.equal((await f.rows('cases', { id: 'HF-500' })).length, 1, 'seed preserves unrelated rows');
  });
  scenarioTest('stale and already-completed results never replace a revised diagnosis', async f => {
    const c = await f.open();
    const start = () => f.service.startTask({ interactionId: f.i.id, specialist: 'engineering', assignment: 'Check calibration.' });
    const old = await start();
    await f.service.recordTaskResult({ taskId: old.id, result: { diagnosis: 'Old diagnosis' } });
    const pending = await start();
    await f.service.updateSymptom({ interactionId: f.i.id, symptom: 'tea is cold too' });
    const stale = await f.service.recordTaskResult({ taskId: pending.id, result: { diagnosis: 'Obsolete diagnosis' } });
    assert.equal(stale.status, 'obsolete'); assert.equal(stale.result.diagnosis, 'Obsolete diagnosis');
    const record = (await f.rows('cases', { id: c.caseId }))[0];
    assert.equal(record.symptom_revision, 2); assert.equal(record.diagnosis, null); assert.equal(record.diagnosis_status, 'none');
    assert.equal((await f.rows('specialist_tasks', { id: old.id }))[0].status, 'obsolete');
    const fresh = await start();
    await f.service.recordTaskResult({ taskId: fresh.id, result: { diagnosis: 'Current proposal', next_step: 'Ask caller to test.' } });
    await f.service.recordTaskResult({ taskId: fresh.id, result: { diagnosis: 'Duplicate result must not replace it' } });
    assert.equal((await f.rows('cases', { id: c.caseId }))[0].diagnosis, 'Current proposal');
  });
  scenarioTest('only caller reports a fix; case stays open until explicit close; late results cannot reopen it', async f => {
    const c = await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'engineering', assignment: 'Check.' });
    await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Proposed cause.' } });
    assert.throws(() => f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'confirmed_fixed' }), { code: 'confirmation_required' });
    await f.service.recordDiagnosisOutcome({ interactionId: f.i.id, outcome: 'confirmed_fixed', callerConfirmed: true });
    assert.equal((await f.rows('cases', { id: c.caseId }))[0].status, 'open');
    const other = await f.service.startTask({ interactionId: f.i.id, specialist: 'logistics', assignment: 'Availability check.' });
    await f.service.recordTaskResult({ taskId: other.id, result: { summary: 'Replacement is out of stock.' } });
    const solution = (await f.service.getInteractionContext({ interactionId: f.i.id })).selected_case.solution;
    assert.equal(solution.source, 'case'); assert.equal(solution.result.diagnosis, 'Proposed cause.');
    assert.doesNotMatch(JSON.stringify(solution), /out of stock/, 'unrelated newer results must not inherit caller confirmation');
    const pending = await f.service.startTask({ interactionId: f.i.id, specialist: 'engineering', assignment: 'Additional check.' });
    assert.throws(() => f.service.closeCase({ interactionId: f.i.id }), { code: 'confirmation_required' });
    await f.service.closeCase({ interactionId: f.i.id, callerConfirmed: true });
    assert.equal((await f.service.recordTaskResult({ taskId: pending.id, result: { diagnosis: 'Late result.' } })).status, 'obsolete');
    const record = (await f.rows('cases', { id: c.caseId }))[0];
    assert.equal(record.status, 'closed'); assert.equal(record.diagnosis_status, 'confirmed_fixed');
  });
  scenarioTest('messages need an explicit request; concurrent duplicates are idempotent and conflicting reuse is rejected', async f => {
    await f.open();
    const args = { interactionId: f.i.id, contactPointId: DEMO.contactId, body: 'Repair steps', idempotencyKey: 'one-message' };
    assert.throws(() => f.service.requestMessage(args), { code: 'message_request_required' });
    const messages = await Promise.all([1, 2, 3].map(() => f.service.requestMessage({ ...args, explicitRequest: true })));
    assert.equal(new Set(messages.map(m => m.id)).size, 1);
    assert.equal((await f.rows('outbound_messages')).length, 1);
    assert.equal((await f.rows('case_events', { kind: 'message_requested' })).length, 1);
    await assert.rejects(() => f.service.requestMessage({ ...args, explicitRequest: true, body: 'Changed request' }), { code: 'idempotency_conflict' });
  });
  scenarioTest('repair follow-up comes from stored facts; parallel durable claims allow only one send attempt', async f => {
    await f.open();
    await assert.rejects(() => f.service.prepareRepairFollowup({ interactionId: f.i.id, fromE164: PHONE }), { code: 'repair_summary_unavailable' });
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'engineering', assignment: 'Check calibration.' });
    await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Calibration may be stale.', next_step: 'Run the fictional calibration cycle.' } });
    const summary = await f.service.prepareRepairFollowup({ interactionId: f.i.id, fromE164: PHONE });
    assert.match(summary.body, /HF-042.*Possible cause: Calibration may be stale/);
    assert.equal(summary.to, PHONE);
    const message = await f.service.requestMessage({ interactionId: f.i.id, contactPointId: summary.contactPointId, body: summary.body, idempotencyKey: summary.idempotencyKey, explicitRequest: true });
    await assert.rejects(() => f.service.getMessageForCallback(message.id), { code: 'message_not_submitted' });
    const claims = await Promise.all([1, 2, 3].map(() => f.service.claimMessageSend(message.id)));
    assert.equal(claims.filter(c => c.claimed).length, 1);
    assert.equal((await f.service.getMessageForCallback(message.id)).id, message.id);
    assert.equal((await f.rows('outbound_messages'))[0].status_history.filter(s => s.status === 'queued').length, 1);
    const anotherService = createCRMService(f.repo);
    assert.equal((await anotherService.claimMessageSend(message.id)).claimed, false);
    await f.service.updateSymptom({ interactionId: f.i.id, symptom: 'new symptom' });
    await assert.rejects(() => f.service.prepareRepairFollowup({ interactionId: f.i.id, fromE164: PHONE }), { code: 'repair_summary_unavailable' });
  });
  scenarioTest('out-of-order and terminal message statuses preserve every observation without moving backward', async f => {
    await f.open();
    const m = await f.service.requestMessage({ interactionId: f.i.id, contactPointId: DEMO.contactId, body: 'Repair', idempotencyKey: 'statuses', explicitRequest: true });
    const statuses = ['queued', 'delivered', 'sent', 'submitted', 'failed', 'delivered'];
    for (const status of statuses) await f.service.recordMessageStatus({ messageId: m.id, status, providerSid: 'SM-test-fixture', errorCode: status === 'failed' ? '30003' : null });
    const result = (await f.rows('outbound_messages'))[0];
    assert.equal(result.status, 'delivered');
    assert.deepEqual(result.status_history.map(h => h.status), ['requested', ...statuses]);
    assert.equal(result.status_history[5].error_code, '30003');
    await assert.rejects(() => f.service.recordMessageStatus({ messageId: m.id, status: 'sent', providerSid: 'different' }), { code: 'provider_sid_conflict' });
    const failure = await f.service.requestMessage({ interactionId: f.i.id, contactPointId: DEMO.contactId, body: 'Repair', idempotencyKey: 'failure', explicitRequest: true });
    await f.service.recordMessageStatus({ messageId: failure.id, status: 'undelivered', providerSid: 'SM-second-fixture' });
    assert.equal((await f.service.recordMessageStatus({ messageId: failure.id, status: 'sent' })).status, 'undelivered');
  });
  scenarioTest('part availability is not a shipment, and shipped requires carrier and ETA', async f => {
    const c = await f.open();
    const args = { caseId: c.caseId, partName: 'Thermal regulator', partNumber: 'TR-2400' };
    const part = await f.service.recordPartUpdate({ ...args, status: 'available' });
    assert.match(await f.service.getCaseBrief(c.caseId), /available/);
    assert.doesNotMatch(await f.service.getCaseBrief(c.caseId), /shipped|courier|ETA/);
    assert.throws(() => f.service.recordPartUpdate({ ...args, partId: part.id, status: 'shipped' }), { code: 'shipment_details_required' });
    await f.service.recordPartUpdate({ ...args, partId: part.id, status: 'shipped', carrier: 'Subspace courier', eta: '2026-10-12T18:00:00Z' });
    assert.match(await f.service.getCaseBrief(c.caseId), /shipped via Subspace courier; ETA tomorrow/);
  });
  scenarioTest('ending a call retains pending work; a later call must confirm before resuming the same case', async f => {
    const c = await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'engineering', assignment: 'Investigate.' });
    await Promise.all([f.service.endInteraction(f.i.id), f.service.endInteraction(f.i.id)]);
    assert.equal((await f.rows('case_events', { kind: 'call_ended' })).length, 1);
    assert.equal((await f.rows('specialist_tasks', { id: task.id }))[0].status, 'working');
    assert.equal((await f.rows('cases'))[0].status, 'open');
    await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'A late proposed diagnosis.' } });
    const next = await f.service.beginInteraction({ providerSid: 'next-call' });
    await f.service.loadProfileByAuthCode({ spokenCode: DEMO.authCode, interactionId: next.id });
    assert.equal((await f.rows('interactions', { id: next.id }))[0].case_id, null);
    await f.service.attachInteraction({ interactionId: next.id, caseId: c.caseId, callerConfirmed: true });
    assert.equal((await f.rows('interactions', { case_id: c.caseId })).length, 2);
    assert.match(await f.service.getInteractionBrief(next.id), /A late proposed diagnosis/);
  });
  scenarioTest('routes widen the queue; reply consent binds to the signed caller number and a pending task', async f => {
    const c = await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'access', assignment: 'elevated: cannot open the science report' });
    assert.equal(task.reply_channel, null);
    assert.throws(() => f.service.startTask({ interactionId: f.i.id, specialist: 'janitorial', assignment: 'x' }), { code: 'invalid_arguments' });
    const consent = { interactionId: f.i.id, taskId: task.id, channel: 'sms', fromE164: PHONE, explicitRequest: true, confirmedDestination: true };
    assert.throws(() => f.service.recordReplyConsent({ ...consent, explicitRequest: false }), { code: 'reply_request_required' });
    assert.throws(() => f.service.recordReplyConsent({ ...consent, confirmedDestination: false }), { code: 'reply_request_required' });
    await assert.rejects(() => f.service.recordReplyConsent({ ...consent, fromE164: '+12025550199' }), { code: 'contact_not_available' });
    await assert.rejects(() => f.service.recordReplyConsent({ ...consent, fromE164: null }), { code: 'contact_not_available' });
    assert.throws(() => f.service.recordReplyConsent({ ...consent, channel: 'fax' }), { code: 'invalid_arguments' });
    await assert.rejects(() => f.service.prepareTaskReply(task.id), { code: 'reply_not_requested' });
    const recorded = await f.service.recordReplyConsent(consent);
    assert.equal(recorded.reply_channel, 'sms'); assert.ok(recorded.reply_contact_point_id); assert.ok(recorded.reply_consent_at);
    assert.deepEqual(await f.service.recordReplyConsent({ ...consent, channel: 'voice' }), recorded, 'first consent wins');
    await assert.rejects(() => f.service.prepareTaskReply(task.id), { code: 'reply_not_ready' });
    assert.deepEqual(await f.service.listRepliesDue(), []);
    const assignment = await f.service.getTaskAssignment(task.id);
    assert.equal(assignment.equipment_model, 'RPL-2400'); assert.equal(assignment.reply_channel, 'sms');
    assert.doesNotMatch(JSON.stringify(assignment), /12025550123|auth_code|contact_point/);
    await f.service.recordTaskResult({ taskId: task.id, result: { summary: 'Clearance lapsed at transfer; 24-hour pass issued.', next_step: 'Retry the report.' } });
    assert.equal((await f.service.listRepliesDue())[0].id, task.id);
    const prep = await f.service.prepareTaskReply(task.id);
    assert.equal(prep.to, PHONE); assert.equal(prep.crewId, DEMO.crewId); assert.equal(prep.caseId, c.caseId); assert.equal(prep.claimed, false);
    assert.match(prep.body, /fictional access result\. Clearance lapsed .* Next: Retry the report\./);
    const claims = await Promise.all([f.service.claimTaskReply(task.id), f.service.claimTaskReply(task.id)]);
    assert.equal(claims.filter(x => x.claimed).length, 1);
    assert.deepEqual(await f.service.listRepliesDue(), []);
    assert.throws(() => f.service.recordTaskReplyOutcome({ taskId: task.id, outcome: 'done' }), { code: 'invalid_arguments' });
    await f.service.recordTaskReplyOutcome({ taskId: task.id, outcome: 'placed', providerSid: `CA${'5'.repeat(32)}` });
    await assert.rejects(() => f.service.recordTaskReplyOutcome({ taskId: task.id, outcome: 'placed', providerSid: `CA${'6'.repeat(32)}` }), { code: 'provider_sid_conflict' });
    const stored = (await f.rows('specialist_tasks', { id: task.id }))[0];
    assert.equal(stored.reply_outcome, 'placed'); assert.equal(stored.reply_provider_sid, `CA${'5'.repeat(32)}`);
    const i = await f.service.beginReplyInteraction(task.id);
    assert.equal(i.direction, 'outbound'); assert.equal(i.channel, 'sms'); assert.equal(i.case_id, c.caseId); assert.equal(i.crew_member_id, DEMO.crewId);
    assert.equal((await f.service.beginReplyInteraction(task.id)).id, i.id);
    assert.deepEqual((await f.rows('case_events')).map(e => e.kind).filter(k => k.startsWith('reply_')), ['reply_requested', 'reply_claimed', 'reply_outcome', 'reply_started']);
  });
  scenarioTest('a result completed before reply consent still requires the caller request and confirmed contact', async f => {
    await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'access', assignment: 'routine: cannot open the report' });
    await f.service.recordTaskResult({ taskId: task.id, result: { summary: 'Fictional access restored.' } });
    assert.deepEqual(await f.service.listRepliesDue(), []);
    const consent = { interactionId: f.i.id, taskId: task.id, channel: 'sms', fromE164: PHONE, explicitRequest: true, confirmedDestination: true };
    assert.throws(() => f.service.recordReplyConsent({ ...consent, explicitRequest: false }), { code: 'reply_request_required' });
    assert.throws(() => f.service.recordReplyConsent({ ...consent, confirmedDestination: false }), { code: 'reply_request_required' });
    await assert.rejects(() => f.service.recordReplyConsent({ ...consent, fromE164: '+12025550199' }), { code: 'contact_not_available' });
    const recorded = await f.service.recordReplyConsent(consent);
    assert.equal(recorded.status, 'result_ready'); assert.equal(recorded.reply_channel, 'sms');
    assert.deepEqual(await f.service.recordReplyConsent({ ...consent, channel: 'voice' }), recorded, 'first consent wins after completion too');
    assert.equal((await f.service.listRepliesDue())[0].id, task.id);
    assert.equal((await f.rows('case_events', { kind: 'reply_requested' })).length, 1);
    await f.service.endInteraction(f.i.id);
    await assert.rejects(() => f.service.recordReplyConsent(consent), { code: 'interaction_ended' });
  });
  scenarioTest('a maintenance result proposes a diagnosis like engineering; a stale task cannot be replied to', async f => {
    await f.open();
    const task = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'routine: coffee cold' });
    await f.service.recordReplyConsent({ interactionId: f.i.id, taskId: task.id, channel: 'voice', fromE164: PHONE, explicitRequest: true, confirmedDestination: true });
    await f.service.updateSymptom({ interactionId: f.i.id, symptom: 'coffee is now lukewarm' });
    const stale = await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Old finding.' } });
    assert.equal(stale.status, 'obsolete');
    await assert.rejects(() => f.service.prepareTaskReply(task.id), { code: 'reply_not_ready' });
    await assert.rejects(() => f.service.claimTaskReply(task.id), { code: 'reply_not_ready' });
    const fresh = await f.service.startTask({ interactionId: f.i.id, specialist: 'maintenance', assignment: 'routine: coffee lukewarm' });
    await assert.rejects(() => f.service.recordReplyConsent({ interactionId: f.i.id, taskId: task.id, channel: 'voice', fromE164: PHONE, explicitRequest: true, confirmedDestination: true }), { code: 'task_not_pending' });
    await f.service.recordTaskResult({ taskId: fresh.id, result: { diagnosis: 'Stale thermal profile.', next_step: 'Recalibrate.' } });
    assert.equal((await f.rows('cases'))[0].diagnosis_status, 'proposed');
    assert.equal((await f.rows('cases'))[0].diagnosis, 'Stale thermal profile.');
  });
  scenarioTest('the roster seeds beside the demo profile, loads by spoken phrase with department and last contact, and never leaks codes or numbers', async f => {
    await seedRoster(f.repo, { now: NOW }); await seedRoster(f.repo, { now: NOW });
    assert.equal((await f.rows('crew_members')).length, ROSTER.length + 1);
    assert.equal((await f.rows('crew_members', { id: DEMO.crewId }))[0].department, 'engineering');
    const call = await f.service.beginInteraction({ providerSid: 'roster-call' });
    const wrong = await f.service.loadProfileByAuthCode({ spokenCode: 'Authorization, Rourke, Tavi, two seven alpha four beta two', interactionId: call.id });
    assert.equal(wrong.ok, false);
    const tavi = await f.service.loadProfileByAuthCode({ spokenCode: 'Authorization, Rourke, Tavi, two seven alpha four beta one', interactionId: call.id });
    assert.equal(tavi.ok, true);
    const p = tavi.profile;
    assert.equal(p.rank, 'Lieutenant'); assert.equal(p.department, 'sciences'); assert.equal(p.section, 'Astrophysics'); assert.equal(p.clearance_level, 5);
    assert.equal(p.posting, 'Deck 11, Astrophysics Lab 2'); assert.equal(p.service_number, 'SF-S-4471'); assert.equal(p.status, 'active');
    assert.equal(p.contact_count, 1); assert.equal(p.last_contact.channel, 'voice'); assert.equal(p.last_contact.case_id, 'HF-031');
    assert.equal(p.open_cases.length, 1); assert.match(p.open_cases[0].brief, /Pending: 1 \(it\)/);
    assert.doesNotMatch(JSON.stringify(p), /27A4B1|auth_code|2025550131|contact_points/);
    const michael = await f.service.loadProfileByAuthCode({ spokenCode: 'Watson, Michael, five nine alpha', interactionId: (await f.service.beginInteraction({ providerSid: 'roster-call-2' })).id });
    assert.equal(michael.ok, true); assert.equal(michael.profile.display_name, 'Michael Watson'); assert.equal(michael.profile.last_contact, null); assert.equal(michael.profile.contact_count, 0); assert.equal(michael.profile.clearance_level, 2);
    const bethanyCall = await f.service.beginInteraction({ providerSid: 'roster-call-nebraska' });
    const bethany = await f.service.loadProfileByAuthCode({ spokenCode: 'Ann, Bethany, seven two alpha', name: 'Bethany Ann', interactionId: bethanyCall.id, demoOnly: true });
    assert.equal(bethany.ok, true);
    assert.equal(bethany.profile.ship, 'USS Nebraska');
    assert.equal((await f.rows('interactions', { id: bethanyCall.id }))[0].crew_member_id, ROSTER[8].id);
    await assert.rejects(() => f.service.recordReporterContext({ crewMemberId: ROSTER[8].id, blob: 'Need help.' }), { code: 'ship_not_found' });
    assert.equal((await f.rows('reporter_contexts', { crew_member_id: ROSTER[8].id })).length, 0);
    assert.deepEqual(await f.service.findCandidatesByPhone('+12025550138'), [ROSTER[7].id]);
    const kai = (await f.rows('crew_members', { id: ROSTER[7].id }))[0];
    assert.equal(kai.status, 'transferred'); assert.equal(kai.ship, 'USS Caldera');
    assert.equal((await f.rows('cases', { status: 'closed' })).length, 1);
    const ids = new Set(ROSTER.map(r => r.service_number)); assert.equal(ids.size, ROSTER.length);
  });
  scenarioTest('transaction rollback leaves no partial row or event', async f => {
    await assert.rejects(f.repo.transaction(async tx => {
      await tx.insert('case_events', { id: randomUUID(), case_id: null, interaction_id: f.i.id, at: NOW.toISOString(), kind: 'note', summary: 'Must roll back.', data: {} });
      throw new Error('injected failure');
    }));
    assert.equal((await f.rows('case_events')).length, 0);
  });
}
