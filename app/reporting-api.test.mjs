import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { DEMO, seedDemo } from '../crm/seed.mjs';
import { ROSTER, seedRoster } from '../crm/roster.mjs';
import { createReportingApi, REPORTING_TOOLS } from './reporting-api.mjs';
import { createApplication } from './server.mjs';
import { loadConfig } from '../voice/config.mjs';

const TOKEN = 'offline-reporting-service-token-123456789';
const NOW = new Date('2026-10-12T12:00:00Z');
const PHONE = '+12025550123';

// In-process HTTP adapter exercise: no listener, network, credentials or external services.
async function request(handle, body, { url = '/api/reporting', method = 'POST', headers = {}, raw } = {}) {
  const req = Readable.from([raw ?? JSON.stringify(body)]);
  Object.assign(req, { url, method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers } });
  const done = Promise.withResolvers();
  let status, responseHeaders;
  const res = { writeHead(code, values) { status = code; responseHeaders = values; }, end(text) {
    done.resolve({ status, headers: responseHeaders, body: JSON.parse(text) });
  } };
  const handled = await handle(req, res);
  if (handled === false) return { handled: false };
  return done.promise;
}

async function fixture(scenario = 'fresh') {
  const repo = new MemoryRepository(); await seedDemo(repo, { scenario, phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const handler = () => createReportingApi({ service, token: TOKEN, now: () => NOW.getTime() });
  const handle = handler();
  const start = async (channel = 'offline-channel-one', target = handle) => request(target, { action: 'start', channel_id: channel });
  const started = await start(); const session = started.body.session_token;
  const tool = (name, args = {}, token = session, target = handle) => request(target, { action: 'tool', session_token: token, name, arguments: args });
  const load = (token = session, target = handle) => tool('load_crew_profile', { spoken_code: DEMO.authCode }, token, target);
  const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
  return { repo, service, handle, handler, start, started, session, tool, load, rows };
}

test('endpoint is disabled without a service token; auth and backend-only checks precede CRM access', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('CRM must not be accessed'); } });
  assert.equal((await request(createReportingApi({ service: forbidden }), { action: 'start' })).status, 404);
  const handle = createReportingApi({ service: forbidden, token: TOKEN });
  for (const authorization of [undefined, '', 'Bearer wrong', TOKEN]) {
    assert.equal((await request(handle, {}, { headers: { authorization } })).status, 401);
  }
  assert.equal((await request(handle, {}, { headers: { origin: 'https://reporting.example.test' } })).status, 403);
  assert.equal((await request(handle, {}, { method: 'GET' })).status, 405);
  assert.equal((await request(handle, {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(handle, {}, { url: '/other' })).handled, false);
  assert.throws(() => createReportingApi({ token: 'short' }), /REPORTING_API_TOKEN/);
});

test('identity gates all CRM context; authorized caller can create, correct and end a durable case', async () => {
  const f = await fixture();
  assert.equal(f.started.status, 200);
  assert.match(f.started.body.instructions, /profile\.preferred_language/);
  assert.equal(f.started.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(f.started.body), /Avery Chen|A484B7|12025550123/);
  for (const [name, args] of [['get_crm_context', {}], ['get_case_brief', {}], ['open_case', { equipment_id: DEMO.equipmentId, symptom: 'cold coffee' }]]) {
    const denied = await f.tool(name, args); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'profile_required');
  }
  const loaded = await f.load(); assert.equal(loaded.status, 200);
  assert.equal(loaded.body.profile.display_name, 'Avery Chen');
  assert.equal(loaded.body.preferred_language, 'english');
  assert.equal(loaded.body.profile.preferred_language, 'english');
  assert.equal(loaded.body.crm_context.profile.preferred_language, 'english');
  assert.equal(loaded.body.crm_context.selected_case, null);
  assert.doesNotMatch(JSON.stringify(loaded.body), /auth_code_hash|A484B7|12025550123|crewId/);
  const opened = await f.tool('open_case', { equipment_id: DEMO.equipmentId, symptom: 'coffee cold' });
  assert.equal(opened.body.crm_context.selected_case.id, 'HF-042');
  assert.equal((await f.tool('open_case', { equipment_id: DEMO.equipmentId, symptom: 'coffee cold' })).body.error.code, 'case_already_selected');
  assert.equal((await f.rows('cases')).length, 1);
  assert.equal((await f.tool('update_symptom', { symptom: 'tea also cold' })).body.crm_context.selected_case.symptom_revision, 2);
  assert.match((await f.tool('get_case_brief')).body.brief, /tea also cold/);
  const end = () => request(f.handle, { action: 'end', session_token: f.session });
  assert.equal((await end()).body.state, 'ended'); assert.equal((await end()).status, 200);
  assert.equal((await f.tool('get_crm_context')).body.error.code, 'interaction_ended');
  assert.equal((await f.start()).body.error.code, 'interaction_ended');
  assert.equal((await f.rows('cases'))[0].status, 'open');
  assert.equal((await f.rows('case_events', { kind: 'call_ended' })).length, 1);
});

test('Klingon preference is returned to the reporter after the demo profile loads', async () => {
  const repo = new MemoryRepository();
  await seedRoster(repo, { now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const handle = createReportingApi({ service, token: TOKEN, now: () => NOW.getTime() });
  const started = await request(handle, { action: 'start', channel_id: 'klingon-channel-one' });
  assert.equal(started.status, 200);
  const loaded = await request(handle, { action: 'tool', session_token: started.body.session_token,
    name: 'load_crew_profile', arguments: { spoken_code: ROSTER[1].auth_code } });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.profile.display_name, 'Michael Watson');
  assert.equal(loaded.body.preferred_language, 'klingon');
  assert.equal(loaded.body.profile.preferred_language, 'klingon');
  assert.equal(loaded.body.crm_context.profile.preferred_language, 'klingon');
  assert.match(loaded.body.crm_context.text, /preferred spoken language klingon/);
  assert.doesNotMatch(JSON.stringify(loaded.body), /auth_code_hash|59A|12025550132/);
});

test('reporting tool loads the demo identity and leaves ship recognition to Decisions', async () => {
  const repo = new MemoryRepository();
  await seedRoster(repo, { now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const handle = createReportingApi({ service, token: TOKEN, now: () => NOW.getTime() });
  const started = await request(handle, { action: 'start', channel_id: 'nebraska-channel-one' });
  const loaded = await request(handle, { action: 'tool', session_token: started.body.session_token,
    name: 'load_crew_profile', arguments: { spoken_code: 'Ann, Bethany, seven two alpha' } });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.profile.display_name, 'Bethany Ann');
  assert.equal(loaded.body.profile.ship, 'USS Nebraska');
  assert.doesNotMatch(JSON.stringify(loaded.body), /auth_code_hash/);
});

test('three-attempt limit survives repeated starts and adapter restarts', async () => {
  const f = await fixture();
  for (let n = 0; n < 3; n++) {
    assert.equal((await f.start()).body.session_token, f.session);
    assert.equal((await f.tool('load_crew_profile', { spoken_code: 'wrong' }, f.session, f.handler())).body.error.code, 'profile_not_found');
  }
  const correct = await f.load(f.session, f.handler());
  assert.equal(correct.status, 429); assert.equal(correct.body.error.code, 'auth_attempt_limit');
  assert.equal((await f.rows('interactions')).length, 1);
});

test('each new channel needs its own code; authenticated session context survives adapter restart', async () => {
  const f = await fixture(); await f.load();
  assert.equal((await f.tool('get_crm_context', {}, f.session, f.handler())).body.crm_context.profile.display_name, 'Avery Chen');
  const other = (await f.start('offline-channel-two')).body.session_token;
  assert.notEqual(other, f.session);
  assert.equal((await f.tool('get_crm_context', {}, other)).body.error.code, 'profile_required');
  assert.equal((await f.load(other)).status, 200);
});

test('session tampering fails; expiry cannot be renewed by start, but expired sessions can be ended', async () => {
  const f = await fixture();
  const [id, expires, signature] = f.session.split('.');
  for (const token of [`${DEMO.crewId}.${expires}.${signature}`, `${id}.${Number(expires) + 1}.${signature}`, 'invalid', `${f.session}.extra`]) {
    assert.equal((await f.tool('get_crm_context', {}, token)).status, 401);
  }
  const later = createReportingApi({ service: f.service, token: TOKEN, now: () => NOW.getTime() + 3600000 });
  assert.equal((await f.tool('get_crm_context', {}, f.session, later)).status, 401);
  assert.equal((await f.start('offline-channel-one', later)).body.error.code, 'session_expired');
  assert.equal((await request(later, { action: 'end', session_token: f.session })).body.state, 'ended');
});

test('returning case selection needs confirmation and rejects another crew member’s case', async () => {
  const f = await fixture('returning'); const loaded = await f.load();
  assert.equal(loaded.body.profile.open_cases[0].caseId, 'HF-038');
  assert.equal((await f.tool('resume_case', { case_id: 'HF-038', caller_confirmed: false })).status, 400);
  await f.repo.transaction(async tx => {
    const original = (await tx.find('cases'))[0];
    await tx.insert('cases', { ...original, id: 'HF-999', crew_member_id: '00000000-0000-4000-8000-000000000999' });
  });
  assert.equal((await f.tool('resume_case', { case_id: 'HF-999', caller_confirmed: true })).body.error.code, 'case_not_available');
  const resumed = await f.tool('resume_case', { case_id: 'HF-038', caller_confirmed: true });
  assert.equal(resumed.body.crm_context.selected_case.id, 'HF-038');
  assert.match(resumed.body.crm_context.selected_case.brief, /Subspace courier/);
});

test('closed case solutions can be reviewed on a new channel without reopening or repeating work', async () => {
  const f = await fixture(); await f.load();
  await f.tool('open_case', { equipment_id: DEMO.equipmentId, symptom: 'coffee cold' });
  const i = (await f.rows('interactions'))[0];
  const task = await f.service.startTask({ interactionId: i.id, specialist: 'maintenance', assignment: 'Check temperature' });
  await f.service.recordTaskResult({ taskId: task.id, result: { diagnosis: 'Calibration drift', next_step: 'Recalibrate' } });
  assert.equal((await f.tool('record_repair_outcome', { outcome: 'confirmed_fixed', caller_confirmed: true })).body.crm_context.selected_case.diagnosis_status, 'confirmed_fixed');
  await f.tool('close_case', { caller_confirmed: true });
  const second = (await f.start('returning-channel')).body.session_token; await f.load(second);
  assert.equal((await f.tool('resume_case', { case_id: 'HF-042', caller_confirmed: true }, second)).body.error.code, 'case_closed');
  const review = await f.tool('review_case', { case_id: 'HF-042', caller_confirmed: true }, second);
  assert.equal(review.body.crm_context.selected_case.status, 'closed');
  assert.equal(review.body.crm_context.selected_case.solution.confirmed_fixed, true);
  assert.equal((await f.rows('specialist_tasks')).length, 1);
});

test('unknown fields, arbitrary identity/destination selectors and provider tools are refused', async () => {
  const f = await fixture();
  for (const body of [null, [], { action: 'start', channel_id: 'x' }, { action: 'start', channel_id: 'valid-channel', phone: PHONE },
    { action: 'end', session_token: f.session, crew_id: DEMO.crewId }]) assert.equal((await request(f.handle, body)).status, 400);
  assert.equal((await f.tool('load_crew_profile', { spoken_code: DEMO.authCode, crew_id: DEMO.crewId })).status, 400);
  assert.equal((await f.tool('load_crew_profile', { spoken_code: 'x'.repeat(251) })).status, 400);
  for (const name of ['route_request', 'request_reply', 'request_repair_sms', 'lookup_repair', '__proto__']) {
    assert.equal((await f.tool(name)).body.error.code, 'unsupported_tool');
    assert.equal(REPORTING_TOOLS.some(tool => tool.name === name), false);
  }
  assert.equal((await request(f.handle, {}, { raw: '{oops' })).body.error.code, 'invalid_json');
  assert.equal((await request(f.handle, {}, { raw: 'x'.repeat(16385) })).status, 413);
});

test('database failures return a safe unavailable error without private driver details', async () => {
  const handle = createReportingApi({ token: TOKEN, service: { beginInteraction: async () => { throw new Error('private database URL'); } } });
  const down = await request(handle, { action: 'start', channel_id: 'unavailable-channel' });
  assert.equal(down.status, 503); assert.deepEqual(down.body, { ok: false, error: { code: 'memory_unavailable' } });
});

test('application mounts the CRM endpoint with voice disabled and invokes no provider', async t => {
  const repo = new MemoryRepository(); await seedDemo(repo, { scenario: 'fresh', phone: PHONE });
  const service = createCRMService(repo);
  const config = loadConfig({ env: { REPORTING_API_TOKEN: TOKEN } });
  const app = createApplication({ config, crmService: service, modelFactory: () => assert.fail('no model'), sendSms: () => assert.fail('no SMS') });
  t.after(() => app.close());
  const handle = (req, res) => { app.server.emit('request', req, res); };
  const started = await request(handle, { action: 'start', channel_id: 'app-mounted-channel' });
  assert.equal(started.status, 200);
  const loaded = await request(handle, { action: 'tool', session_token: started.body.session_token,
    name: 'load_crew_profile', arguments: { spoken_code: DEMO.authCode } });
  assert.equal(loaded.body.profile.display_name, 'Avery Chen');
});
