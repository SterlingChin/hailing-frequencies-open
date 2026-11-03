import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { PostgresRepository, createPool } from '../crm/repo-postgres.mjs';
import { requireLocalDatabase } from '../crm/env.mjs';
import { migrate } from '../scripts/db-migrate.mjs';
import { createCRMService } from '../crm/service.mjs';
import { DEMO, seedDemo } from '../crm/seed.mjs';
import { ROSTER, seedRoster } from '../crm/roster.mjs';
import { loadConfig } from '../voice/config.mjs';
import { createContextApplication } from './context-server.mjs';
import { createApplication } from './server.mjs';
import { createDecisionStep } from '../decisions/step.mjs';
import { createDecisionsClient } from '../decisions/client.mjs';
import { callbackStatus, createDecisionsApi, MAX_DECISION_BODY_BYTES } from './decisions-api.mjs';

const TOKEN = 'offline-decisions-service-token-123456789';
const PHRASE = 'Authorization, Chen, Avery. Alpha seven, Bravo nine, Echo two.';
const PHONE = '+12025550123';
const NOW = '2026-10-12T19:00:00.000Z';
const wireAnswers = (route = 'it', details = 0.01, confidence = 0.99) => [
  { name: 'route', type: 'choice', choice: route, confidence, probabilities: [{ value: route, probability: confidence }] },
  { name: 'resolvable_now', type: 'predicate', probability: route === 'none' ? 0.99 : 0.01 },
  { name: 'needs_more_details', type: 'predicate', probability: details },
  { name: 'urgency', type: 'score', score: 0, confidence: 0.99, probabilities: [{ value: 0, label: 'routine', probability: 1 }] },
];

// No socket, API key, provider or browser traffic: exercise the actual request
// listener and Decisions wire client using an injected, clearly labeled fake.
async function fixture(t, { route = 'it', enabled = true, repo = new MemoryRepository(), specialists = null, normalEntry = false } = {}) {
  await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: new Date() });
  const service = createCRMService(repo);
  const config = loadConfig({ env: { REPORTING_API_TOKEN: TOKEN, DECISIONS_ENABLED: String(enabled), OPENAI_API_KEY: 'sk-offline-fixture' } });
  const calls = [], dispatched = [];
  let response = { status: 200, answers: wireAnswers(route) };
  const compose = normalEntry ? options => createApplication({ ...options, decisionsClient: createDecisionsClient({ apiKey: enabled ? 'sk-offline-fixture' : null, fetch: options.decisionFetch }) }) : createContextApplication;
  const app = compose({ config, crmService: service,
    decisionFetch: async (url, init) => {
      calls.push({ url, init });
      if (response.error) throw response.error;
      return { status: response.status, headers: new Headers(), json: async () => ({ model: 'gpt-6-luna', answers: response.answers }) };
    },
    specialists: specialists ?? {}, onQueued: id => dispatched.push(id),
    modelFactory: () => assert.fail('No voice model in this fixture'),
    sendSms: () => assert.fail('No SMS in this fixture'), placeCall: () => assert.fail('No callback in this fixture'),
  });
  t.after(() => app.close());
  async function request(path, body, { headers = {}, raw, method = 'POST' } = {}) {
    const req = Readable.from([raw ?? JSON.stringify(body)]);
    Object.assign(req, { url: path, method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers } });
    const done = Promise.withResolvers(); let status;
    app.server.emit('request', req, { writeHead(value) { status = value; }, end(text) { done.resolve({ status, body: JSON.parse(text) }); } });
    return done.promise;
  }
  const start = await request('/api/reporting', { action: 'start', channel_id: 'offline-decision-channel' });
  const session = start.body.session_token;
  const tool = (name, args = {}) => request('/api/reporting', { action: 'tool', session_token: session, name, arguments: args });
  const decide = (requestText = 'The report will not open') => request('/api/decisions', { session_token: session, request: requestText });
  const load = () => tool('load_crew_profile', { spoken_code: PHRASE });
  const open = async () => { await load(); return tool('open_case', { equipment_id: DEMO.equipmentId, symptom: 'The report will not open' }); };
  const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
  return { app, repo, service, calls, dispatched, request, session, tool, decide, load, open, rows, respond: value => { response = value; } };
}

for (const route of ['it', 'maintenance']) test(`${route}: identity, authoritative CRM, Decisions and deduplicated queue share one session`, async t => {
  const f = await fixture(t, { route, normalEntry: route === 'it' });
  assert.equal((await f.decide()).body.error.code, 'profile_required'); assert.equal(f.calls.length, 0);
  const loaded = await f.load(); assert.equal(loaded.body.profile.display_name, 'Avery Chen');
  assert.equal((await f.decide()).body.reason, 'case_required'); assert.equal(f.calls.length, 0);
  await f.tool('open_case', { equipment_id: DEMO.equipmentId, symptom: 'The report will not open' });
  const { status, body } = await f.decide('Please help. Call +1 (202) 555-0123.');
  assert.equal(status, 200); assert.equal(body.fictional, true); assert.equal(body.outcome, 'queue');
  assert.equal(body.state, 'queued'); assert.equal(body.route, route); assert.equal(body.callback_owner, route);
  assert.equal(body.callback_status, 'not_requested'); assert.equal(body.reused, false);
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk-offline-fixture');
  const payload = JSON.parse(f.calls[0].init.body);
  assert.ok(payload.input.startsWith(body.context.text));
  assert.match(payload.input, /expert_engineering.*it.*maintenance/);
  assert.deepEqual(body.context, body.crm_context);
  assert.equal(body.action.type, 'route_to_expert');
  assert.equal(body.action.desk, route);
  assert.equal(body.action.tool_call.name, 'expert_engineering');
  assert.deepEqual(JSON.parse(body.action.tool_call.arguments.context), body.context); assert.match(payload.safety_identifier, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(payload.input, /A7B9E2|Alpha seven|12025550123|555-0123|auth_code_hash/);
  assert.doesNotMatch(JSON.stringify(body), /reply_contact_point|reply_provider_sid|sk-offline|session_token/);
  assert.deepEqual((await f.service.getTaskAssignment(body.task_id)).context, body.crm_context);
  const second = await f.decide(); assert.equal(second.body.task_id, body.task_id); assert.equal(second.body.reused, true);
  assert.deepEqual(f.dispatched, []);
  assert.deepEqual(second.body.action.tool_call, body.action.tool_call);
  assert.equal(second.body.action.dispatch_key, body.task_id);
  assert.equal(second.body.action.dispatch_policy, 'reconcile_existing'); assert.equal((await f.rows('specialist_tasks')).length, 1);
});

test('legacy pending assignments are redacted before returning a proposed MCP call', async t => {
  const f = await fixture(t); await f.open();
  const legacy = await f.service.startTask({ interactionId: f.session.split('.')[0], specialist: 'access',
    assignment: 'Call +1 (202) 555-0123 about the report' });
  const { body } = await f.decide();
  assert.equal(body.task_id, legacy.id); assert.equal(body.reused, true);
  assert.equal(body.action.desk, 'it'); assert.equal(body.action.dispatch_policy, 'reconcile_existing');
  assert.match(body.action.tool_call.arguments.question, /\[number withheld\]/);
  assert.doesNotMatch(JSON.stringify(body), /555-0123|12025550123/);
  assert.deepEqual(f.dispatched, []);
});

test('stored solutions are returned, rejected answers cannot be reused, and provider failures queue nothing', async t => {
  const f = await fixture(t); await f.open();
  const { body: queued } = await f.decide();
  await f.service.recordTaskResult({ taskId: queued.task_id, result: { diagnosis: 'Fixture permission repaired', next_step: 'Open the report again' } });
  f.respond({ status: 200, answers: wireAnswers('none') });
  const answer = (await f.decide('What did IT find?')).body;
  assert.equal(answer.action.type, 'respond'); assert.equal(answer.outcome, 'solution'); assert.equal(answer.task_id, null); assert.equal(answer.solution.confirmed_fixed, false);
  assert.equal(answer.solution.result.next_step, 'Open the report again'); assert.equal(f.dispatched.length, 0);
  await f.tool('record_repair_outcome', { outcome: 'not_fixed', caller_confirmed: true });
  assert.equal((await f.decide()).body.reason, 'stored_solution_unavailable');
  for (const response of [{ status: 429 }, { status: 200, answers: [] }, { error: new Error('private failure') }]) {
    f.respond(response);
    const failed = (await f.decide()).body;
    assert.equal(failed.action, null); assert.equal(failed.outcome, 'undecided'); assert.equal(failed.task_id, null);
    assert.doesNotMatch(JSON.stringify(failed), /private failure/);
  }
  assert.equal((await f.rows('specialist_tasks')).length, 1);
});

test('missing details with low route confidence and disabled Decisions never start a specialist', async t => {
  const f = await fixture(t); await f.open(); f.respond({ status: 200, answers: wireAnswers('it', 0.99, 0.5) });
  assert.equal((await f.decide()).body.outcome, 'needs_more_details'); assert.equal(f.dispatched.length, 0);
  const disabled = await fixture(t, { enabled: false }); await disabled.open();
  assert.equal((await disabled.decide()).body.reason, 'decisions_unavailable'); assert.equal(disabled.calls.length, 0);
});

test('service auth, origin, session and argument checks run before Decisions; ended sessions cannot classify', async t => {
  const f = await fixture(t); await f.open();
  const body = { session_token: f.session, request: 'Fixture request' };
  assert.equal((await f.request('/api/decisions', body, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.request('/api/decisions', body, { headers: { origin: 'https://ui.example.test' } })).status, 403);
  assert.equal((await f.request('/api/decisions', { ...body, session_token: f.session + 'tampered' })).status, 401);
  assert.equal((await f.request('/api/decisions', { ...body, profile: { display_name: 'Injected' } })).status, 400);
  assert.equal((await f.request('/api/decisions', { ...body, request: 'x'.repeat(301) })).status, 400);
  assert.equal((await f.request('/api/decisions', body, { raw: '{broken' })).status, 400);
  assert.equal((await f.request('/api/decisions', body, { raw: 'x'.repeat(MAX_DECISION_BODY_BYTES + 1) })).status, 413);
  assert.equal((await f.request('/api/decisions', body, { method: 'GET' })).status, 405);
  assert.equal((await f.request('/api/decisions', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  await f.request('/api/reporting', { action: 'end', session_token: f.session });
  assert.equal((await f.decide()).body.error.code, 'interaction_ended'); assert.equal(f.calls.length, 0);
});

test('callback attempts are never projected as completed', () => {
  const requested = { reply_channel: 'voice', reply_consent_at: 'fixture-time' };
  assert.equal(callbackStatus({}), 'not_requested'); assert.equal(callbackStatus(requested), 'callback_requested');
  assert.equal(callbackStatus({ ...requested, reply_claimed_at: 'fixture-time' }), 'placement_unknown');
  assert.equal(callbackStatus({ ...requested, reply_outcome: 'placed' }), 'call_placed');
  assert.equal(callbackStatus({ ...requested, reply_outcome: 'failed' }), 'failed');
  assert.equal(callbackStatus({ ...requested, reply_outcome: 'unavailable' }), 'unavailable');
  assert.throws(() => createDecisionsApi({ token: 'short' }), /REPORTING_API_TOKEN/);
});

test('reporting actor gathers context, executes a fake MCP handoff, then reuses the solved answer', async t => {
  let backendDispatches = 0;
  const f = await fixture(t, { normalEntry: true, specialists: { it: async () => { backendDispatches++; assert.fail('Backend must not dispatch MCP'); } } });
  await f.open();
  f.respond({ status: 200, answers: wireAnswers('it', 0.99, 0.5) });
  const gather = (await f.decide()).body;
  assert.equal(gather.action.type, 'gather_context');
  assert.equal(gather.task_id, null);
  assert.equal((await f.rows('specialist_tasks')).length, 0);
  // The reporting actor asks the caller, saves their answer, and explicitly
  // requests another classification. Decisions never retries itself.
  assert.equal(f.calls.length, 1);
  await f.tool('update_symptom', { symptom: 'The report says permission denied' });
  f.respond({ status: 200, answers: wireAnswers() });
  const handoff = (await f.decide('Permission denied when opening the report')).body;
  assert.equal(handoff.action.type, 'route_to_expert');
  assert.equal(handoff.context.selected_case.symptom, 'The report says permission denied');
  assert.equal(backendDispatches, 0); assert.deepEqual(f.dispatched, []);
  const mcpCalls = [], claims = new Set();
  async function fakeReportingDispatch(action) {
    if (claims.has(action.dispatch_key)) return; // reporting backend owns this claim
    claims.add(action.dispatch_key);
    const call = action.tool_call;
    assert.equal(call.name, 'expert_engineering');
    assert.deepEqual(JSON.parse(call.arguments.context), handoff.context);
    mcpCalls.push(call);
    // Fake expert completion persisted through the CRM service; no real MCP.
    await f.service.recordTaskResult({ taskId: action.task_id, result: { summary: 'Fixture permission advice', next_step: 'Reopen the report' } });
  }
  await fakeReportingDispatch(handoff.action);
  await fakeReportingDispatch(handoff.action);
  assert.equal(mcpCalls.length, 1);
  const refreshed = (await f.tool('get_crm_context')).body.crm_context;
  assert.equal(refreshed.queue[0].status, 'result_ready');
  f.respond({ status: 200, answers: wireAnswers('none') });
  const finding = (await f.decide('What did IT find?')).body;
  assert.equal(finding.action.type, 'respond');
  assert.equal(finding.action.solution.confirmed_fixed, false);
  await f.tool('record_repair_outcome', { outcome: 'confirmed_fixed', caller_confirmed: true });
  const solved = (await f.decide('That fixed it')).body;
  assert.equal(solved.action.type, 'respond');
  assert.equal(solved.action.solution.confirmed_fixed, true);
  assert.equal(solved.task_id, null);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
  assert.equal((await f.rows('specialist_tasks'))[0].reply_outcome, null);
  assert.equal(backendDispatches, 0); assert.deepEqual(f.dispatched, []);
});

test('Postgres: reporting session, decision and specialist snapshot persist across application restart', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const url = requireLocalDatabase(process.env.TEST_DATABASE_URL);
  const schema = `decisions_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const repo = new PostgresRepository({ pool: createPool(url, { options: `-c search_path=${schema}` }) });
  t.after(async () => { await repo.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  await migrate(repo.pool);
  const f = await fixture(t, { repo }); await f.open();
  const { body } = await f.decide();
  assert.equal(body.state, 'queued');
  f.respond({ status: 200, answers: reporterAnswers(body.crm_context.selected_case.id) });
  const blob = 'Reporter transcript before restart.\nEvery character survives.';
  const reporter = (await fromReporter(f, blob)).body;
  assert.ok(reporter.context_id);
  await f.app.close();
  const service = createCRMService(repo);
  const persisted = await service.getReporterContext({ crewMemberId: DEMO.crewId, contextId: reporter.context_id });
  assert.equal(persisted.reporter_contexts[0].text, blob);
  assert.equal((await repo.pool.query('SELECT body FROM reporter_contexts WHERE id=$1', [reporter.context_id])).rows[0].body, blob);
  const config = loadConfig({ env: { REPORTING_API_TOKEN: TOKEN } });
  const restarted = createContextApplication({ config, crmService: service });
  t.after(() => restarted.close());
  const req = Readable.from([JSON.stringify({ action: 'tool', session_token: f.session, name: 'get_crm_context', arguments: {} })]);
  Object.assign(req, { url: '/api/reporting', method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  const done = Promise.withResolvers();
  restarted.server.emit('request', req, { writeHead(status) { assert.equal(status, 200); }, end(text) { done.resolve(JSON.parse(text)); } });
  const restored = await done.promise;
  assert.equal(restored.crm_context.profile.display_name, 'Avery Chen');
  assert.equal(restored.crm_context.queue[0].id, body.task_id);
  assert.deepEqual((await service.getTaskAssignment(body.task_id)).context, body.crm_context);
});

const reporterAnswers = (issue, route = 'it', details = 0.01, routeConfidence = 0.99, issueConfidence = 0.99) => [
  ...wireAnswers(route, details, routeConfidence),
  { name: 'issue', type: 'choice', choice: issue, confidence: issueConfidence, probabilities: [{ value: issue, probability: issueConfidence }] },
];
const fromReporter = (f, context, crewId = DEMO.crewId, options) => f.request('/api/decisions', { crew_member_id: crewId, context }, options);

test('USS Nebraska is nonexistent: Decisions says crew not found before storing or classifying', async t => {
  const f = await fixture(t);
  await seedRoster(f.repo);
  const expected = { ok: false, error: { code: 'crew_member_not_found', reason: 'ship_not_found',
    message: 'USS Nebraska does not exist in this demo.' } };
  const reporter = await fromReporter(f, 'Bethany Ann needs help.', ROSTER[8].id);
  assert.deepEqual(reporter, { status: 404, body: expected });
  assert.equal((await f.rows('reporter_contexts', { crew_member_id: ROSTER[8].id })).length, 0);
  assert.equal(f.calls.length, 0);
  const loaded = await f.tool('load_crew_profile', { spoken_code: ROSTER[8].auth_code });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.profile.display_name, 'Bethany Ann');
  assert.deepEqual(await f.decide('Bethany Ann needs help.'), { status: 404, body: expected });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows('cases', { crew_member_id: ROSTER[8].id })).length, 0);
});

test('Avery personal-log access: both reported score sets route to IT and a fake approval returns to the reporter', async t => {
  const f = await fixture(t);
  const blob = 'Avery Chen cannot access his own personal logs and is requesting access.';
  let taskId, caseId, handoff;
  for (const [routeConfidence, issueConfidence, details, urgency] of [[0.96, 0.42, 0.8, 0.01], [0.97, 0.64, 0.48, 0.17]]) {
    const answers = reporterAnswers('unclear', 'it', details, routeConfidence, issueConfidence);
    answers.find(answer => answer.name === 'urgency').score = urgency;
    f.respond({ status: 200, answers });
    const { body } = await fromReporter(f, blob);
    assert.equal(body.outcome, 'queue'); assert.equal(body.action.type, 'route_to_expert');
    assert.equal(body.reason, 'route_it_without_case_match'); assert.equal(body.action.desk, 'it');
    assert.equal(body.issue, 'unclear', 'retain the model answer, not a fabricated confident match');
    assert.deepEqual(body.answers.issue, { value: 'unclear', confidence: issueConfidence });
    assert.equal(body.answers.route.confidence, routeConfidence); assert.equal(body.answers.needs_more_details, details);
    assert.equal(body.context.selected_case.equipment_id, null); assert.equal(body.solution, null);
    if (taskId) {
      assert.equal(body.task_id, taskId); assert.equal(body.reused, true);
      assert.deepEqual(body.action.tool_call, handoff.tool_call);
    } else {
      taskId = body.task_id; caseId = body.context.selected_case.id; handoff = body.action;
      assert.deepEqual(JSON.parse(handoff.tool_call.arguments.context), body.context);
    }
  }
  assert.equal((await f.rows('equipment')).length, 1, 'do not turn personal logs into replicator equipment');
  assert.equal((await f.rows('cases')).length, 1); assert.equal((await f.rows('specialist_tasks')).length, 1);
  const assignment = await f.service.getTaskAssignment(taskId);
  assert.equal(assignment.equipment_model, null); assert.equal(assignment.equipment_location, null);
  assert.match(JSON.stringify(assignment.context), /personal logs/);
  assert.deepEqual(f.dispatched, [], 'the reporter, not Decisions, invokes the expert');

  // Explicit fake IT completion. Route confidence itself never grants access.
  await f.service.recordTaskResult({ taskId, result: { summary: 'Access to your own personal logs is approved.',
    next_step: 'Open your personal logs again.', source_id: 'fake-it-access-approval' } });
  f.respond({ status: 200, answers: reporterAnswers(caseId, 'none') });
  const approved = (await fromReporter(f, 'What did IT decide about access to my personal logs?')).body;
  assert.equal(approved.action.type, 'respond'); assert.equal(approved.task_id, null);
  assert.equal(approved.solution.result.summary, 'Access to your own personal logs is approved.');
  assert.equal(approved.solution.confirmed_fixed, false);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
});

test('a low-confidence existing case match cannot reuse or mutate an unrelated solved case', async t => {
  const f = await fixture(t); await f.open();
  const originalCase = (await f.rows('cases'))[0];
  f.respond({ status: 200, answers: reporterAnswers(originalCase.id, 'it', 1, 0.51, 0.1) });
  const { body } = await fromReporter(f, 'I need access to my own personal logs.');
  assert.equal(body.action.type, 'route_to_expert'); assert.notEqual(body.context.selected_case.id, originalCase.id);
  assert.equal(body.context.selected_case.equipment_id, null);
  assert.deepEqual((await f.rows('cases', { id: originalCase.id }))[0], originalCase);
});

test('explicit unassigned intake works without equipment but a 0.50 route still cannot hand off', async t => {
  const f = await fixture(t);
  await f.repo.transaction(tx => tx.remove('equipment', { crew_member_id: DEMO.crewId }));
  f.respond({ status: 200, answers: reporterAnswers('new:unassigned', 'it', 0.8, 0.5) });
  assert.equal((await fromReporter(f, 'Please help with personal-log access.')).body.action.type, 'gather_context');
  f.respond({ status: 200, answers: reporterAnswers('new:unassigned', 'it', 0.8, 0.500001) });
  const { body } = await fromReporter(f, 'Please help with personal-log access.');
  assert.equal(body.action.type, 'route_to_expert'); assert.equal(body.context.selected_case.equipment_id, null);
  assert.equal(body.issue, 'new:unassigned'); assert.equal((await f.rows('equipment')).length, 0);
});

for (const route of ['it', 'maintenance']) test(`${route}: trusted crew ID and a full reporter blob persist and route without a caller session`, async t => {
  const f = await fixture(t, { normalEntry: true });
  const preferredLanguage = route === 'it' ? 'klingon' : 'english';
  await f.repo.transaction(tx => tx.update('crew_members', DEMO.crewId, { preferred_language: preferredLanguage }));
  f.respond({ status: 200, answers: reporterAnswers(`new:${DEMO.equipmentId}`, route) });
  const blob = `Reporter: Here is the conversation.\nUser: ${'Detailed context. '.repeat(350)}\n最後: the report will not open.\nCall +1 (202) 555-0123.`;
  const { status, body } = await fromReporter(f, blob);
  assert.equal(status, 200); assert.equal(body.action.type, 'route_to_expert'); assert.equal(body.route, route);
  assert.equal(body.context.version, 2); assert.equal(body.context.crew_member_id, DEMO.crewId);
  assert.equal(body.context.profile.display_name, 'Avery Chen');
  assert.equal(body.context.profile.preferred_language, preferredLanguage);
  assert.equal(body.context.reporter_contexts[0].id, body.context_id);
  assert.match(body.context.reporter_contexts[0].text, /最後: the report will not open/);
  assert.equal((await f.rows('reporter_contexts'))[0].body, blob, 'private CRM stores the exact supplied text');
  assert.equal((await f.rows('reporter_contexts'))[0].case_id, body.context.selected_case.id);
  assert.equal((await f.rows('interactions'))[0].auth_attempts, 0, 'reporter identity is trusted without a phrase check');
  assert.equal((await f.rows('interactions')).length, 1, 'intake does not pretend to be an additional phone call');
  const payload = JSON.parse(f.calls[0].init.body);
  assert.equal(payload.questions.length, 5); assert.equal(payload.questions.at(-1).name, 'issue');
  assert.match(payload.input, /最後: the report will not open/);
  assert.ok(payload.input.includes(`"preferred_language":"${preferredLanguage}"`));
  assert.ok(payload.questions.at(-1).choices.some(choice => choice.value === `new:${DEMO.equipmentId}`));
  assert.deepEqual(JSON.parse(body.action.tool_call.arguments.context), body.context);
  assert.doesNotMatch(JSON.stringify(body), /555-0123|auth_code_hash|A7B9E2|contact_point/);
  assert.deepEqual(f.dispatched, []);
});

test('reporter follow-ups keep every blob, gather context, reuse pending work and return a stored answer', async t => {
  const f = await fixture(t);
  f.respond({ status: 200, answers: reporterAnswers('unclear', 'it', 0.99, 0.5) });
  const first = (await fromReporter(f, 'Something is broken; let me check which system.')).body;
  assert.equal(first.action.type, 'gather_context'); assert.equal(first.task_id, null);
  assert.match(first.next_action, /same crew_member_id and fuller conversation text as context/);
  assert.equal((await f.rows('cases')).length, 0);
  f.respond({ status: 200, answers: reporterAnswers(`new:${DEMO.equipmentId}`) });
  const routed = (await fromReporter(f, 'The science report says permission denied.')).body;
  assert.equal(routed.action.type, 'route_to_expert'); assert.equal(routed.context.reporter_contexts.length, 2);
  const caseId = routed.context.selected_case.id;
  const input = JSON.parse(f.calls[1].init.body).input;
  assert.match(input, /Something is broken/); assert.match(input, /permission denied/);
  f.respond({ status: 200, answers: reporterAnswers(caseId) });
  const pending = (await fromReporter(f, 'This is the same permission problem.')).body;
  assert.equal(pending.task_id, routed.task_id); assert.equal(pending.reused, true);
  assert.equal(pending.context.reporter_contexts.length, 3);
  assert.deepEqual(pending.action.tool_call, routed.action.tool_call, 'an existing dispatch retains its original snapshot');
  await f.service.recordTaskResult({ taskId: routed.task_id, result: { diagnosis: 'Permission restored', next_step: 'Reopen the report' } });
  f.respond({ status: 200, answers: reporterAnswers(caseId, 'none') });
  const solution = (await fromReporter(f, 'What did IT find about my report?')).body;
  assert.equal(solution.action.type, 'respond'); assert.equal(solution.solution.confirmed_fixed, false);
  assert.equal(solution.context.reporter_contexts.length, 4); assert.equal(solution.task_id, null);
  assert.equal((await f.rows('specialist_tasks')).length, 1); assert.deepEqual(f.dispatched, []);
});

test('fake second-turn scoring hands a registered warp-drive problem to Maintenance without more troubleshooting', async t => {
  const f = await fixture(t);
  // Explicit fixture prerequisite: the attached production trace only had a
  // replicator registered. Scoring cannot invent the missing equipment record.
  await f.repo.transaction(tx => tx.update('equipment', DEMO.equipmentId, { model: 'Warp drive', location: 'Engine bay' }));
  f.respond({ status: 200, answers: reporterAnswers('unclear', 'maintenance', 0.9, 0.5) });
  const first = (await fromReporter(f, 'A warp drive has failed; I have not identified its location yet.')).body;
  assert.equal(first.action.type, 'gather_context');
  assert.equal((await f.rows('specialist_tasks')).length, 0);

  // These scores are injected policy examples, not predictions of gpt-6-luna.
  f.respond({ status: 200, answers: reporterAnswers(`new:${DEMO.equipmentId}`, 'maintenance', 0.65) });
  const second = (await fromReporter(f, 'Confirmed issue: A malfunctioning warp drive. Location: Engine bay.')).body;
  assert.equal(second.action.type, 'route_to_expert');
  assert.equal(second.action.desk, 'maintenance');
  assert.equal(second.answers.needs_more_details, 0.65);
  assert.equal(second.context.reporter_contexts.length, 2);
  assert.deepEqual(JSON.parse(second.action.tool_call.arguments.context), second.context);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.dispatched, []);
});

test('the attached unavailable pattern preserves context and instructs no more questions without scoring', async t => {
  const f = await fixture(t, { enabled: false });
  for (const blob of [
    'A warp drive has failed.',
    'The malfunctioning warp drive is in the engine bay.',
    'It was off when I arrived; pressing the button did not turn it on.',
    'There were no warning lights, sounds or messages.',
    'It remains powered off.',
  ]) {
    const { body } = await fromReporter(f, blob);
    assert.equal(body.outcome, 'undecided'); assert.equal(body.reason, 'decisions_unavailable');
    assert.equal(body.action, null); assert.equal(body.answers.needs_more_details, null);
    assert.equal(body.answers.route.confidence, null);
    assert.match(body.next_action, /not a request for more caller details/);
    assert.match(body.next_action, /do not ask another troubleshooting question or automatically resubmit/);
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(f.dispatched, []);
  assert.equal((await f.rows('reporter_contexts')).length, 5);
  assert.equal((await f.rows('specialist_tasks')).length, 0);
});

test('a confident Maintenance route creates an unassigned case instead of inventing equipment', async t => {
  const f = await fixture(t);
  f.respond({ status: 200, answers: reporterAnswers('unclear', 'maintenance', 0.01) });
  const { body } = await fromReporter(f, 'The warp drive in the engine bay has failed.');
  assert.equal(body.reason, 'route_maintenance_without_case_match'); assert.equal(body.action.type, 'route_to_expert');
  assert.equal(body.action.desk, 'maintenance');
  assert.equal(body.context.selected_case.equipment_id, null);
  assert.equal((await f.rows('equipment')).length, 1);
  assert.equal((await f.rows('cases')).length, 1);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
});

test('complete reporter context includes every owned case, queue entry and history without another crew’s records', async t => {
  const f = await fixture(t, { enabled: false });
  const records = [];
  for (let i = 0; i < 7; i++) {
    // Trusted fixture setup only; API input never accepts case/profile overrides.
    const record = await f.repo.transaction(tx => tx.insert('cases', { id: `HF-${100 + i}`, crew_member_id: DEMO.crewId,
      equipment_id: DEMO.equipmentId, status: 'open', title: `Case ${i}`, symptom: `Symptom ${i}`, symptom_revision: 1,
      diagnosis: null, diagnosis_status: 'none', next_step: null, opened_at: NOW, updated_at: NOW, resolved_at: null }));
    records.push(record);
  }
  await f.load();
  await f.tool('resume_case', { case_id: records[6].id, caller_confirmed: true });
  for (let i = 0; i < 12; i++) await f.service.startTask({ interactionId: f.session.split('.')[0], specialist: 'it', assignment: `Pending task ${i}` });
  const other = randomUUID();
  await f.repo.transaction(async tx => {
    const original = (await tx.find('crew_members', { id: DEMO.crewId }))[0];
    await tx.insert('crew_members', { ...original, id: other, display_name: 'Another caller', auth_code_hash: 'f'.repeat(64) });
    await tx.insert('reporter_contexts', { id: randomUUID(), crew_member_id: other, case_id: null, body: 'UNRELATED PRIVATE CONVERSATION', created_at: NOW });
  });
  const { body } = await fromReporter(f, 'Please check all my issues.');
  assert.equal(body.context.cases.length, 7); assert.equal(body.context.profile.open_cases.length, 7);
  assert.equal(body.context.queue.length, 12); assert.equal(body.context.history.length, 1);
  assert.equal(body.context.reporter_contexts.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /UNRELATED PRIVATE|Another caller/);
});

test('reporter blobs survive disabled Decisions, failures and refusals; forged issue choices cannot create tasks', async t => {
  const disabled = await fixture(t, { enabled: false });
  const saved = await fromReporter(disabled, 'Keep this even when Decisions is off.');
  assert.equal(saved.status, 200); assert.equal(saved.body.reason, 'decisions_unavailable');
  assert.ok(saved.body.context_id); assert.equal(disabled.calls.length, 0);
  assert.equal((await disabled.rows('reporter_contexts')).length, 1);
  const f = await fixture(t);
  for (const response of [
    { status: 429 },
    { status: 200, answers: reporterAnswers('HF-999999') },
    { status: 200, answers: [...wireAnswers(), { name: 'issue', type: 'refusal', reason: 'refused' }] },
    { error: new Error('private transport failure') },
  ]) {
    f.respond(response);
    const result = await fromReporter(f, 'Preserve this request despite a provider failure.');
    assert.equal(result.status, 200); assert.equal(result.body.action, null);
    assert.equal(result.body.outcome, 'undecided'); assert.ok(result.body.context_id);
    assert.doesNotMatch(JSON.stringify(result.body), /private transport failure/);
  }
  assert.equal((await f.rows('reporter_contexts')).length, 4);
  assert.equal((await f.rows('specialist_tasks')).length, 0);
});

test('reporter intake rejects unknown IDs, malformed blobs and unauthenticated backends before storage or classification', async t => {
  const f = await fixture(t);
  assert.equal((await fromReporter(f, 'hello', randomUUID())).status, 404);
  assert.equal((await fromReporter(f, 'hello', 'not-a-uuid')).status, 400);
  for (const blob of ['', '  ', null, {}, 'x'.repeat(64001), 'bad\0text', '\uD800']) assert.equal((await fromReporter(f, blob)).status, 400);
  assert.equal((await fromReporter(f, 'hello', DEMO.crewId, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fromReporter(f, 'hello', DEMO.crewId, { headers: { origin: 'https://browser.example.test' } })).status, 403);
  assert.equal((await f.request('/api/decisions', { crew_member_id: DEMO.crewId, context: 'hello', profile: {} })).status, 400);
  assert.equal((await f.rows('reporter_contexts')).length, 0); assert.equal(f.calls.length, 0);
});

test('a newer reporter blob invalidates an in-flight handoff instead of mixing unclassified context into it', async t => {
  const f = await fixture(t); await f.open();
  const existing = (await f.rows('cases'))[0];
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const step = createDecisionStep({ service: f.service, client: { enabled: true, async decide() {
    started.resolve(); await finish.promise;
    return { ok: true, answers: reporterAnswers(existing.id) };
  } } });
  const pending = step.evaluateReporter({ crewMemberId: DEMO.crewId, blob: 'First reporter request' });
  await started.promise;
  await f.service.recordReporterContext({ crewMemberId: DEMO.crewId, blob: 'A newer fact arrived during classification' });
  finish.resolve();
  const result = await pending;
  assert.equal(result.outcome, 'undecided'); assert.equal(result.reason, 'context_changed');
  assert.equal((await f.rows('specialist_tasks')).length, 0);
  assert.equal((await f.rows('reporter_contexts')).length, 2);
});

test('context beyond the handoff budget remains stored and is not silently truncated or sent to a provider', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.service.recordReporterContext({ crewMemberId: DEMO.crewId, blob: 'x'.repeat(64000) });
  const result = (await fromReporter(f, 'Latest complete request.')).body;
  assert.equal(result.reason, 'context_capacity_exceeded'); assert.equal(result.action, null);
  assert.equal(result.context.reporter_contexts.length, 4);
  assert.equal(result.context.reporter_contexts.filter(item => item.text.length === 64000).length, 3);
  assert.equal(f.calls.length, 0);
});
