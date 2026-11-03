import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApi } from '../server/api.mjs';
import { PHRASE, confirmIdentity, captureReport } from '../server/reporting.mjs';

async function request(api, path, { method = 'GET', body, cookie, csrf, origin = 'http://localhost:5173', observe } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.url = path; req.method = method; req.socket = {};
  req.headers = { host: 'localhost:5173', origin, 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
  const res = new EventEmitter(); res.headers = {}; res.data = ''; res.writableEnded = false;
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.end = value => { res.data = value ?? ''; res.writableEnded = true; res.writableFinished = true; };
  observe?.(res);
  await api.handle(req, res);
  return { status: res.statusCode, body: res.data && JSON.parse(res.data), cookie: res.headers['set-cookie']?.split(';')[0], cookieHeader: res.headers['set-cookie'] };
}
function liveFixture(t) {
  const channels = [];
  const api = createApi({ env: { LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture', LIVE_SESSION_LIMIT: '100' }, createLive: async ({ state, notify }) => {
    const channel = { state, notify }; channels.push(channel);
    return { sdp: 'fixture-answer', ready() {}, stop() { state.active = false; state.liveStatus = 'ended'; notify(); } };
  } });
  t.after(api.close);
  return { api, channels, capture(issue) { const channel = channels.at(-1); confirmIdentity(channel.state, PHRASE); captureReport(channel.state, { issue }); channel.notify(); } };
}
test('API requires same-origin CSRF and isolates crew sessions', async t => {
  const f = liveFixture(t), api = f.api;
  const session = await request(api, '/api/session');
  assert.equal(session.cookieHeader.includes('Max-Age='), false);
  const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  assert.equal((await request(api, '/api/begin', { ...context, origin: 'https://attacker.example', body: { mode: 'live', sdp: 'offer' } })).status, 403);
  assert.equal((await request(api, '/api/begin', { ...context, csrf: 'bad', body: { mode: 'live', sdp: 'offer' } })).status, 403);
  assert.equal((await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer' } })).status, 200);
  f.capture('Power failure on deck 7');
  assert.equal((await request(api, '/api/session', { cookie: session.cookie })).body.report.delivery, 'not_sent');
  const other = await request(api, '/api/session');
  assert.equal(other.body.authorized, false);
  assert.equal(other.body.report, null);
  await request(api, '/api/stop', { ...context, body: {} });
  assert.equal((await request(api, '/api/report', { ...context, body: { issue: 'Corrected report', location: 'Deck 7' } })).body.report.reviewed, true);
  assert.equal((await request(api, '/api/demo/message', { ...context, body: { text: 'late' } })).status, 404);
});
test('Live cannot create provider traffic unless configured', async t => {
  let created = false;
  const api = createApi({ env: {}, createLive: () => { created = true; } }); t.after(api.close);
  const health = await request(api, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ready', service: 'reporting-ui', liveEnabled: false, externalDeliveryEnabled: false });
  const session = await request(api, '/api/session');
  const result = await request(api, '/api/begin', { method: 'POST', cookie: session.cookie, csrf: session.body.csrf, body: { mode: 'live', sdp: 'offer' } });
  assert.equal(result.status, 503); assert.equal(created, false);
  assert.equal(result.body.error, 'Live is not configured on this server.');
});
test('new channels retain previous reports without carrying over identity', async t => {
  const f = liveFixture(t), api = f.api;
  const session = await request(api, '/api/session');
  const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: 'first-channel' } });
  f.capture('Original issue');
  const id = (await request(api, '/api/session', { cookie: session.cookie })).body.report.id;
  await request(api, '/api/stop', { ...context, body: { channelId: 'first-channel' } });
  const next = await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: 'second-channel' } });
  assert.equal(next.body.report.id, id); assert.equal(next.body.authorized, false); assert.equal(next.body.hasCurrentReport, false);
  await request(api, '/api/report', { ...context, body: { id, issue: 'Edited original', location: '' } });
  assert.equal((await request(api, '/api/session', { cookie: session.cookie })).body.authorized, false);
  assert.equal((await request(api, '/api/stop', { ...context, body: { channelId: 'first-channel' } })).body.active, true);
  f.capture('Another issue');
  const selected = await request(api, '/api/report/select', { ...context, body: { id } });
  assert.equal(selected.body.report.issue, 'Edited original');
  assert.equal(selected.body.reports.length, 2);
});
test('a stop that arrives before begin prevents that cancelled channel from starting', async t => {
  const api = createApi({ env: {} }); t.after(api.close);
  const session = await request(api, '/api/session');
  const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  await request(api, '/api/stop', { ...context, body: { channelId: 'cancelled-channel' } });
  assert.equal((await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: 'cancelled-channel' } })).status, 409);
});
test('a cancelled in-flight Live creation closes the eventual session', async t => {
  let finish, stopped = false;
  const api = createApi({ env: { LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture' }, createLive: () => new Promise(resolve => { finish = resolve; }) }); t.after(api.close);
  const session = await request(api, '/api/session');
  const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  const pending = request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer' } });
  await new Promise(resolve => setImmediate(resolve));
  await request(api, '/api/stop', { ...context, body: {} });
  finish({ sdp: 'answer', stop: () => { stopped = true; } });
  const result = await pending;
  assert.equal(stopped, true);
  assert.equal(result.status, 409);
});

test('scripted demo channels and demo message routes are unavailable', async t => {
  const f = liveFixture(t), api = f.api;
  const session = await request(api, '/api/session');
  const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  assert.equal((await request(api, '/api/begin', { ...context, body: { mode: 'demo' } })).status, 400);
  assert.equal((await request(api, '/api/demo/message', { ...context, body: { text: PHRASE } })).status, 404);
  assert.equal(f.channels.length, 0);
});

test('real rehearsal actions stay behind the browser session and share one server-side CRM bridge', async t => {
  let starts = 0;
  const calls = [];
  const api = createApi({ env: {}, createBridge: () => ({ async start() {
    starts++;
    const bridge = { active: true, context: { profile: { display_name: 'Avery Chen' }, selected_case: null }, decision: null, timeline: [],
      public() { return { active: this.active, context: this.context, decision: this.decision, timeline: this.timeline }; },
      async call(name, args) { calls.push({ name, args }); if (name === 'route_request') this.decision = { ok: true, outcome: 'queue', answers: { route: { value: 'it' } } };
        return { ok: true, crm_context: this.context }; },
      async end() { this.active = false; } };
    return bridge;
  } }) }); t.after(api.close);
  const session = await request(api, '/api/session');
  const auth = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  assert.equal((await request(api, '/api/rehearsal', { method: 'POST', cookie: session.cookie, body: { action: 'start' } })).status, 403);
  assert.equal((await request(api, '/api/rehearsal', { ...auth, body: { action: 'start' } })).body.active, true);
  assert.equal(starts, 1);
  assert.equal((await request(api, '/api/rehearsal', { ...auth, body: { action: 'decide', request: 'Report will not open' } })).body.decision.answers.route.value, 'it');
  assert.deepEqual(calls, [{ name: 'route_request', args: { request: 'Report will not open' } }]);
  assert.equal((await request(api, '/api/rehearsal', { ...auth, body: { action: 'end' } })).body.active, false);
  assert.equal((await request(api, '/api/rehearsal', { ...auth, body: { action: 'refresh' } })).status, 409);
});

test('ended channels can be reopened beyond the old process session budget', async t => {
  const f = liveFixture(t), api = f.api;
  const session = await request(api, '/api/session');
  const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  for (let attempt = 0; attempt < 105; attempt++) {
    assert.equal((await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: `channel-${attempt}` } })).status, 200);
    f.capture(`Issue ${attempt}`);
    await request(api, '/api/stop', { ...context, body: { channelId: `channel-${attempt}` } });
  }
  assert.equal(f.channels.length, 105);
  assert.equal((await request(api, '/api/session', { cookie: session.cookie })).body.reports.length, 100);
  assert.equal('liveRemaining' in (await request(api, '/api/session', { cookie: session.cookie })).body, false);
});

test('voice handover keeps the authorized channel and rejects stale or duplicate switches', async t => {
  let creations = 0;
  const api = createApi({ env: { LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture' }, createLive: async ({ state, conversation }) => {
    creations++; state.authorized = true; state.profile = { display_name: 'Michael Watson', preferred_language: 'klingon' }; state.liveVoice = creations === 1 ? 'marin' : 'cedar';
    conversation.identity = { valid: () => true };
    return { sdp: 'answer', ready() {}, stop() { state.active = false; }, retireForVoiceChange: async () => true };
  } }); t.after(api.close);
  const session = await request(api, '/api/session'); const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: 'language-channel' } });
  assert.equal((await request(api, '/api/live/voice', { ...context, body: { sdp: 'offer', channelId: 'wrong-channel' } })).status, 409);
  const switched = await request(api, '/api/live/voice', { ...context, body: { sdp: 'offer', channelId: 'language-channel' } });
  assert.equal(switched.status, 200); assert.equal(switched.body.authorized, true); assert.equal(switched.body.channelId, 'language-channel'); assert.equal(switched.body.liveVoice, 'cedar');
  assert.equal(switched.body.voiceSwitchPending, false);
  assert.equal((await request(api, '/api/live/voice', { ...context, body: { sdp: 'offer', channelId: 'language-channel' } })).status, 409); assert.equal(creations, 2);
});
test('ending a channel during voice handover prevents creating the replacement session', async t => {
  let creations = 0, completeClose;
  const api = createApi({ env: { LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture' }, createLive: async ({ state, conversation }) => {
    creations++; state.authorized = true; state.profile = { display_name: 'Michael Watson', preferred_language: 'klingon' }; state.liveVoice = 'marin'; conversation.identity = { valid: () => true };
    return { sdp: 'answer', ready() {}, stop() { state.active = false; }, retireForVoiceChange: () => new Promise(resolve => { completeClose = resolve; }) };
  } }); t.after(api.close);
  const session = await request(api, '/api/session'); const context = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
  await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: 'language-channel' } });
  const switchRequest = request(api, '/api/live/voice', { ...context, body: { sdp: 'offer', channelId: 'language-channel' } });
  await new Promise(resolve => setImmediate(resolve));
  await request(api, '/api/stop', { ...context, body: { channelId: 'language-channel' } });
  assert.equal((await request(api, '/api/begin', { ...context, body: { mode: 'live', sdp: 'offer', channelId: 'next-language-channel' } })).status, 409);
  completeClose(true);
  assert.equal((await switchRequest).status, 409); assert.equal(creations, 1);
});

test('debug responses are scoped to the requesting browser and preserve raw decision reasons', async t => {
 t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, outcome: 'undecided', reason: 'low_route_confidence', session_token: 'upstream-private' })));
 const api = createApi({ env: { LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture-private-key' }, createLive: async ({ state, fetchImpl, notify }) => {
  await fetchImpl('https://fixture.test/api/decisions', { method: 'POST' });
  notify(); return { sdp: 'answer', stop() {}, ready() {} };
 } });
 t.after(api.close);
 const session = await request(api, '/api/session');
 await request(api, '/api/begin', { method: 'POST', cookie: session.cookie, csrf: session.body.csrf, body: { mode: 'live', sdp: 'offer' } });
 const current = await request(api, '/api/session', { cookie: session.cookie });
 assert.equal(JSON.parse(current.body.debugResponses[0].body).reason, 'low_route_confidence');
 assert.equal(JSON.parse(current.body.debugResponses[0].body).session_token, '[REDACTED]');
 const other = await request(api, '/api/session');
 assert.deepEqual(other.body.debugResponses, []);
});

test('page reset clears conversation, identity, reports and debug history without restoring late updates', async t => {
 const f = liveFixture(t), session = await request(f.api, '/api/session');
 const post = { method: 'POST', cookie: session.cookie, csrf: session.body.csrf };
 await request(f.api, '/api/begin', { ...post, body: { mode: 'live', sdp: 'offer', channelId: 'old-channel' } });
 f.capture('Old issue'); const old = f.channels[0];
 old.state.crmContext = { cases: [{ id: 'old-case' }] }; old.state.decision = { outcome: 'undecided' }; old.state.expert = { status: 'dispatched' }; old.state.debugResponses = [{ body: 'old response' }];
 const other = await request(f.api, '/api/session');
 const reset = await request(f.api, '/api/reset', { ...post, body: {} });
 assert.equal(reset.status, 200); assert.notEqual(reset.body.csrf, session.body.csrf);
 assert.equal(reset.body.active, false); assert.equal(reset.body.authorized, false); assert.equal(reset.body.crew, null);
 assert.equal(reset.body.report, null); assert.deepEqual(reset.body.reports, []); assert.deepEqual(reset.body.debugResponses, []);
 assert.equal(reset.body.crmContext, null); assert.equal(reset.body.decision, null); assert.equal(reset.body.expert, null);
 old.notify(); const current = await request(f.api, '/api/session', { cookie: session.cookie }); assert.equal(current.body.report, null);
 assert.equal((await request(f.api, '/api/session', { cookie: other.cookie })).body.csrf, other.body.csrf);
 assert.equal((await request(f.api, '/api/begin', { ...post, body: { mode: 'live', sdp: 'offer' } })).status, 403);
});

test('closing a pre-reset Begin response cannot stop the replacement channel', async t => {
 let finishOld, oldResponse, creates = 0, oldStops = 0, newStops = 0;
 const api = createApi({ env: { LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture' }, createLive: ({ state }) => {
  if (++creates === 1) return new Promise(resolve => { finishOld = () => resolve({ sdp: 'old', stop() { oldStops++; state.active = false; } }); });
  return { sdp: 'new', stop() { newStops++; state.active = false; } };
 } });
 t.after(api.close);
 const session = await request(api, '/api/session');
 const old = request(api, '/api/begin', { method: 'POST', cookie: session.cookie, csrf: session.body.csrf, body: { mode: 'live', sdp: 'old offer' }, observe: res => { oldResponse = res; } });
 await new Promise(resolve => setImmediate(resolve));
 const reset = await request(api, '/api/reset', { method: 'POST', cookie: session.cookie, csrf: session.body.csrf, body: {} });
 await request(api, '/api/begin', { method: 'POST', cookie: session.cookie, csrf: reset.body.csrf, body: { mode: 'live', sdp: 'new offer' } });
 oldResponse.emit('close');
 assert.equal(newStops, 0);
 finishOld(); await old;
 assert.equal(oldStops, 1);
 assert.equal((await request(api, '/api/session', { cookie: session.cookie })).body.active, true);
});
