import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startLive, liveConfig } from '../server/live.mjs';
import { createInteraction, PHRASE, confirmIdentity, CREW } from '../server/reporting.mjs';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
function fixture() {
  const socket = new FakeSocket(), state = createInteraction();
  state.mode = 'live';
  let request;
  return { state, socket, get request() { return request; }, options: {
    contextClient: { start: async () => ({ ok: true, sessionToken: 'fixture-context' }), authorize: async (_token, args) => { const r = confirmIdentity(state, args.authorization); return r.ok ? { ok: true, profile: { ...CREW, display_name: CREW.name } } : r; }, end: async () => ({ ok: true }) },
    state, apiKey: 'fixture-key', maxMs: 5000, closeMs: 15,
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ session: { id: 'live_fixture' }, transport: { sdp: 'fixture-answer' } }) };
    }, connect: () => socket,
  } };
}
async function tool(socket, name, args, callId) {
  socket.receive({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId } } });
  await new Promise(resolve => setImmediate(resolve));
}
test('an established conversation is not ended by an application duration cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), live = await startLive(f.options);
  live.ready();
  t.mock.timers.tick(125000);
  assert.equal(f.state.liveStatus, 'connected');
  assert.equal(f.socket.sent.some(event => event.type === 'session.close'), false);
  live.stop(); f.socket.receive({ type: 'session.closed' });
});
test('tool-call bookkeeping does not terminate a long conversation', async () => {
  const f = fixture(), live = await startLive(f.options); live.ready();
  for (let i = 0; i < 1100; i++) await tool(f.socket, 'unknown_tool', {}, `tool-${i}`);
  assert.equal(f.state.liveStatus, 'connected');
  assert.equal(f.socket.sent.filter(event => event.type === 'response.create').length, 1100);
  await tool(f.socket, 'unknown_tool', {}, 'tool-1099');
  assert.equal(f.socket.sent.filter(event => event.type === 'response.create').length, 1100);
  live.stop(); f.socket.receive({ type: 'session.closed' });
});
test('Live defaults off and requires explicit enablement plus a server key', () => {
  assert.equal(liveConfig({}).enabled, false);
  assert.equal(liveConfig({ LIVE_ENABLED: 'true' }).enabled, false);
  assert.equal(liveConfig({ LIVE_ENABLED: 'true', OPENAI_API_KEY: 'fixture' }).enabled, true);
});
test('WebRTC configuration keeps tools server-side and uses accepted request fields', async () => {
  const f = fixture(), live = await startLive(f.options);
  assert.equal(live.sdp, 'fixture-answer');
  assert.equal(Object.hasOwn(f.request.body, 'store'), false);
  assert.equal(f.request.body.transport.type, 'webrtc');
  assert.equal(f.request.body.session.model, 'gpt-live-1');
  assert.deepEqual(f.request.body.session.client.data_channel.allowed_client_events, ['session.close']);
  assert.deepEqual(f.request.body.session.client.data_channel.allowed_server_events, [
    { type: 'session.started' }, { type: 'session.closed' },
    { type: 'session.input_transcript.delta' }, { type: 'session.output_transcript.delta' }, { type: 'error' },
  ]);
  live.ready(); live.ready();
  assert.equal(f.socket.sent.filter(e => e.type === 'session.commentary.append').length, 1);
  live.stop(); f.socket.receive({ type: 'session.closed' });
});
test('delegated tools enforce identity, deduplicate calls, and continue the backend', async () => {
  const f = fixture(), live = await startLive(f.options); live.ready();
  await tool(f.socket, 'capture_issue', { issue: 'Broken hatch', location: 'Deck 7' }, 'early');
  assert.equal(f.state.report, null);
  await tool(f.socket, 'authorize_caller', { name: 'Avery Chen', authorization: PHRASE }, 'auth');
  assert.equal(f.state.authorized, true);
  await tool(f.socket, 'capture_issue', { issue: 'Broken hatch', location: 'Deck 7' }, 'report');
  assert.equal(f.state.report.delivery, 'not_sent');
  await tool(f.socket, 'capture_issue', { issue: 'Duplicate overwrite', location: '' }, 'report');
  assert.equal(f.state.report.issue, 'Broken hatch');
  assert.equal(f.socket.sent.filter(e => e.type === 'response.create').length, 3);
  live.stop(); f.socket.receive({ type: 'session.closed' });
});
test('stop rejects further tools and acknowledges finalization only from session.closed', async () => {
  const f = fixture(), live = await startLive(f.options);
  live.stop();
  assert.equal(f.state.liveStatus, 'closing');
  await tool(f.socket, 'authorize_caller', { name: 'Avery Chen', authorization: PHRASE }, 'late');
  assert.equal(f.state.authorized, false);
  f.socket.receive({ type: 'session.closed' });
  assert.equal(f.state.liveStatus, 'ended');
});
test('provider errors are sanitized, and an uncertain close is marked unconfirmed', async () => {
  const f = fixture(), live = await startLive(f.options);
  f.socket.receive({ type: 'error', error: { message: 'private-provider-detail' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.state.liveStatus, 'unconfirmed');
  assert.equal(live.sdp, 'fixture-answer');
  const bad = fixture();
  bad.options.fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'invalid_api_key' } }) });
  bad.options.onDiagnostic = () => {};
  await assert.rejects(startLive(bad.options), /OpenAI rejected the server API key/);
});
test('creation rejection identifies invalid request fields without exposing provider payloads', async () => {
  const f = fixture(), diagnostics = [];
  f.options.onDiagnostic = value => diagnostics.push(value);
  f.options.fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'invalid_type', param: 'session.client.data_channel.allowed_server_events[0]', message: 'private raw body and fixture-key' } }) });
  await assert.rejects(startLive(f.options), /Invalid Live configuration.*allowed_server_events/);
  assert.equal(JSON.stringify(diagnostics).includes('private raw body'), false);
  assert.equal(JSON.stringify(diagnostics).includes('fixture-key'), false);
  assert.equal(diagnostics[0].status, 400);
});
test('quota errors are distinguished from rate limiting', async () => {
  for (const [code, message] of [['insufficient_quota', /API credits or spending limit/], ['rate_limit_exceeded', /temporarily rate limited/]]) {
    const f = fixture(); f.options.onDiagnostic = () => {};
    f.options.fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { code } }) });
    await assert.rejects(startLive(f.options), message);
  }
});
test('GPT Live delegates a CRM decision to the real-data bridge without exposing its token', async () => {
  const f = fixture();
  const calls = [];
  const backend = { tools: [{ type: 'function', name: 'route_request', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } }],
    async call(name, args) { calls.push({ name, args }); return { ok: true, outcome: 'queue', route: 'maintenance' }; } };
  const live = await startLive({ ...f.options, backend });
  assert.equal(f.request.body.session.delegation.responses.tools[0].name, 'route_request');
  tool(f.socket, 'route_request', { request: 'replicator fails' }, 'decision');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ name: 'route_request', args: { request: 'replicator fails' } }]);
  assert.equal(JSON.parse(f.socket.sent.find(e => e.type === 'response.item.create').item.output).route, 'maintenance');
  live.stop(); f.socket.receive({ type: 'session.closed' });
});

test('manual context refresh does not bypass expired identity', async () => {
  const f = fixture();
  let crmCalls = 0;
  f.options.contextClient.start = async () => ({ ok: true, sessionToken: 'private-context', expiresAt: '2000-01-01T00:00:00Z' });
  f.options.crmClient = { start: async () => { crmCalls++; return { ok: true, session_token: 'private-reporting' }; }, call: async () => { crmCalls++; return { ok: true }; }, end: async () => ({ ok: true }) };
  const live = await startLive(f.options); live.ready(); await new Promise(resolve => setImmediate(resolve));
  f.state.authorized = true;
  assert.equal((await live.refreshContext()).error.code, 'identity_required');
  assert.equal(crmCalls, 0);
  live.stop(); f.socket.receive({ type: 'session.closed' });
});

test('Klingon startup chooses Cedar and preserves authorization during acknowledged media handover', async () => {
  const f = fixture(); f.state.active = true;
  const conversation = {}; f.options.conversation = conversation;
  let identityEnds = 0, crmEnds = 0;
  f.options.contextClient.end = async () => { identityEnds++; return { ok: true }; };
  const authorize = f.options.contextClient.authorize;
  f.options.contextClient.authorize = async (...args) => { const result = await authorize(...args); return { ...result, profile: { ...result.profile, preferred_language: 'klingon' } }; };
  f.options.crmClient = { start: async () => ({ ok: true, session_token: 'private-crm' }), call: async () => ({ ok: true, crm_context: { profile: { preferred_language: 'klingon' } } }), end: async () => { crmEnds++; return { ok: true }; } };
  const first = await startLive(f.options); first.ready();
  assert.equal(f.request.body.session.audio.output.voice, 'marin');
  await tool(f.socket, 'authorize_caller', { name: 'Avery Chen', authorization: PHRASE }, 'auth-language');
  assert.equal(f.state.profile.preferred_language, 'klingon');
  assert.equal(f.socket.sent.some(event => event.type === 'response.create'), false);
  const retired = first.retireForVoiceChange(); await new Promise(resolve => setImmediate(resolve));
  f.socket.receive({ type: 'session.closed' }); assert.equal(await retired, true);
  assert.equal(f.state.active, true); assert.equal(identityEnds, 0); assert.equal(crmEnds, 0);
  const next = fixture(); next.options.state = f.state; next.options.conversation = conversation;
  const second = await startLive(next.options); second.ready();
  assert.equal(next.request.body.session.audio.output.voice, 'cedar');
  assert.match(next.request.body.session.instructions, /Speak Klingon/);
  assert.match(next.request.body.session.instructions, /do not ask for identity again/);
  f.socket.emit('error', new Error('late old transport error'));
  f.socket.emit('message', Buffer.from('invalid old frame'));
  assert.equal(f.state.active, true); assert.equal(identityEnds, 0);
  second.stop(); next.socket.receive({ type: 'session.closed' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(identityEnds, 1); assert.equal(crmEnds, 0);
});
test('media handover fails closed when the provider does not acknowledge closure', async () => {
  const f = fixture(); f.state.active = true;
  const live = await startLive(f.options); live.ready();
  assert.equal(await live.retireForVoiceChange(), false);
  assert.equal(f.state.active, false); assert.equal(f.state.liveStatus, 'unconfirmed');
  live.stop();
});

test('live reporter exposes only confirmation submission tools and never makes case decisions', async () => {
  const f = fixture(), sent = [];
  f.options.contextClient.authorize = async () => ({ ok: true, crewMemberId: '11111111-1111-4111-8111-111111111111', profile: { display_name: 'Avery Chen', preferred_language: 'english' } });
  f.options.crmClient = { submit: async (crew, context) => { sent.push({ crew, context }); return { ok: true, context_id: 'receipt', action: { type: 'gather_context' }, outcome: 'needs_more_details' }; }, start: () => assert.fail('No reporting session'), call: () => assert.fail('No local case decisions'), end: async () => ({ ok: true }) };
  const live = await startLive(f.options); live.ready();
  assert.deepEqual(f.request.body.session.delegation.responses.tools.map(tool => tool.name), ['authorize_caller', 'capture_issue', 'submit_report']);
  await tool(f.socket, 'authorize_caller', { name: 'Avery Chen', authorization: PHRASE }, 'auth-submit');
  await tool(f.socket, 'capture_issue', { issue: 'Hatch is stuck', location: 'Deck 7' }, 'draft-submit');
  const args = { report_id: f.state.report.id, report_revision: f.state.report.revision, context: 'Caller: Hatch is stuck. Reporter: Is that correct? Caller: Yes.', caller_confirmed: true };
  await tool(f.socket, 'submit_report', args, 'confirmed-submit');
  await tool(f.socket, 'submit_report', args, 'same-revision-submit');
  assert.equal(sent.length, 1); assert.equal(f.state.report.contextId, 'receipt'); assert.equal(f.state.decision.action.type, 'gather_context');
  live.stop(); f.socket.receive({ type: 'session.closed' });
});
