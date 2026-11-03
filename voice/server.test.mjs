import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import twilio from 'twilio';
import WebSocket from 'ws';
import { createVoiceServer } from './server.mjs';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { seedDemo, DEMO } from '../crm/seed.mjs';
import { lookupRepair } from './config.mjs';

const config = { publicOrigin: 'https://voice.example.test', accountSid: `AC${'1'.repeat(32)}`, authToken: 'fixture-not-a-credential' };
const callSid = `CA${'2'.repeat(32)}`;
function model() {
  const ws = new EventEmitter(); ws.readyState = 1; ws.sent = [];
  ws.send = raw => { const event = JSON.parse(raw); ws.sent.push(event);
    if (event.type === 'session.start') queueMicrotask(() => ws.emit('message', Buffer.from(JSON.stringify({ type: 'session.started' }))));
    if (event.type === 'session.close') queueMicrotask(() => ws.emit('message', Buffer.from(JSON.stringify({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } }))));
  };
  ws.close = () => { if (ws.readyState !== 3) { ws.readyState = 3; ws.emit('close'); } }; ws.terminate = ws.close;
  return ws;
}
async function fixture(t, crmService = null, overrides = {}) {
  let opened = 0; const summaries = [], models = [];
  const app = createVoiceServer({ config: { ...config, ...overrides }, crmService, modelFactory: () => { opened++; const socket = model(); models.push(socket); return socket; }, onSummary: s => summaries.push(s), bridgeOptions: { closeTimeoutMs: 100 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, summaries, models, get opened() { return opened; } };
}
async function webhook(f, params = { AccountSid: config.accountSid, CallSid: callSid }, signed = true) {
  return fetch(`${f.base}/incoming-call`, { method: 'POST', body: new URLSearchParams(params), headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(signed ? { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, `${config.publicOrigin}/incoming-call`, params) } : {}),
    'X-Forwarded-Host': 'untrusted.example',
  } });
}
test('unsigned and wrong-account webhooks cannot start a model', async t => {
  const f = await fixture(t);
  assert.equal((await webhook(f, undefined, false)).status, 403);
  assert.equal((await webhook(f, { AccountSid: `AC${'9'.repeat(32)}`, CallSid: callSid })).status, 403);
  assert.equal(f.opened, 0);
});
test('signed webhook pins canonical WSS origin and appends hangup', async t => {
  const f = await fixture(t); const r = await webhook(f); const xml = await r.text();
  assert.equal(r.status, 200);
  assert.match(xml, /wss:\/\/voice\.example\.test\/media-stream\//);
  assert.match(xml, /<Parameter name="ticket" value="[a-f0-9]{48}"/);
  assert.match(xml, /<\/Connect><Hangup\/>/);
  assert.doesNotMatch(xml, /untrusted\.example/);
  assert.equal(f.opened, 0);
});
test('unsigned websocket is refused before creating an upstream', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(`${f.base.replace(/^http/, 'ws')}/media-stream/`);
  const result = await new Promise(resolve => { ws.on('unexpected-response', (_, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); }); ws.on('error', () => {}); });
  assert.equal(result, 403); assert.equal(f.opened, 0);
});
for (const input of ['null', 'binary', 'unicode-ticket']) {
  test(`signed websocket rejects ${input} without opening the model`, async t => {
    const f = await fixture(t); await webhook(f);
    const ws = new WebSocket(`${f.base.replace(/^http/, 'ws')}/media-stream/`, { headers: {
      'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, 'wss://voice.example.test/media-stream/', {}),
    } });
    await once(ws, 'open'); const closed = once(ws, 'close');
    if (input === 'null') ws.send('null');
    else if (input === 'binary') ws.send(Buffer.from('{}'));
    else ws.send(JSON.stringify({ event: 'start', start: { accountSid: config.accountSid, callSid, customParameters: { ticket: 'é'.repeat(48) } } }));
    assert.equal((await closed)[0], 1008); assert.equal(f.opened, 0);
  });
}
test('issued ticket starts one model; stop finalizes; another call is rejected', async t => {
  const f = await fixture(t); const xml = await (await webhook(f)).text();
  const ticket = xml.match(/name="ticket" value="([a-f0-9]+)"/)[1];
  const ws = new WebSocket(`${f.base.replace(/^http/, 'ws')}/media-stream/`, { headers: {
    'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, 'wss://voice.example.test/media-stream/', {}),
  } });
  await once(ws, 'open');
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({ event: 'start', streamSid: `MZ${'3'.repeat(32)}`, start: {
    accountSid: config.accountSid, callSid, streamSid: `MZ${'3'.repeat(32)}`, customParameters: { ticket },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.opened, 1);
  const close = once(ws, 'close'); ws.send(JSON.stringify({ event: 'stop', streamSid: `MZ${'3'.repeat(32)}` })); await close;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.summaries.length, 1); assert.equal(f.summaries[0].finalized, true);
  const next = await webhook(f, { AccountSid: config.accountSid, CallSid: `CA${'4'.repeat(32)}` });
  assert.match(await next.text(), /<Reject reason="busy"/);
  assert.equal(f.opened, 1);
});
test('repair lookup uses authored data and refuses unsupported models and malformed arguments', () => {
  assert.equal(lookupRepair({ equipment_model: 'RPL-7', symptom: 'cold coffee' }).source_id, 'federation-demo-rpl7-cold-001');
  assert.equal(lookupRepair({ equipment_model: 'RPL-2400', symptom: 'cold coffee' }).source_id, 'federation-demo-rpl2400-cold-001');
  assert.equal(lookupRepair({ equipment_model: 'unknown', symptom: 'cold coffee' }).ok, false);
  assert.equal(lookupRepair({ equipment_model: 'RPL-7', symptom: 'cold coffee', order: true }).ok, false);
});

async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected mock call state did not arrive');
}
async function connectCall(f, from, id = callSid) {
  const previous = f.models.length;
  const xml = await (await webhook(f, { AccountSid: config.accountSid, CallSid: id, From: from })).text();
  assert.doesNotMatch(xml, new RegExp(from.replace('+', '\\+')));
  const ticket = xml.match(/name="ticket" value="([a-f0-9]+)"/)[1];
  const ws = new WebSocket(`${f.base.replace(/^http/, 'ws')}/media-stream/`, { headers: {
    'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, 'wss://voice.example.test/media-stream/', {}),
  } });
  await once(ws, 'open');
  ws.send(JSON.stringify({ event: 'start', streamSid: 'MZcrm', start: { callSid: id, accountSid: config.accountSid,
    streamSid: 'MZcrm', customParameters: { ticket, From: '+12025550999' },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  await until(() => f.models.length === previous + 1 && f.models[previous].sent.some(e => e.type === 'session.instructions.append'));
  return ws;
}
async function invoke(f, name, args, callId) {
  const socket = f.models[0];
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.event', event: { type: 'response.output_item.done', item: {
    type: 'function_call', status: 'completed', name, call_id: callId, arguments: JSON.stringify(args),
  } } })));
  await until(() => socket.sent.some(e => e.item?.call_id === callId));
  return JSON.parse(socket.sent.find(e => e.item?.call_id === callId).item.output);
}
test('signed call context loads memory privately, confirms a case, and persists its end', async t => {
  const phone = '+12025550123';
  const repo = new MemoryRepository();
  await seedDemo(repo, { scenario: 'returning', phone });
  const service = createCRMService(repo);
  const hints = [];
  const f = await fixture(t, { ...service, findCandidatesByPhone: from => { hints.push(from); return service.findCandidatesByPhone(from); } });
  const ws = await connectCall(f, phone);
  await until(() => hints.length === 1);
  assert.deepEqual(hints, [phone], 'only signed webhook From reaches CRM, not a stream parameter');
  const session = f.models[0].sent.find(e => e.type === 'session.start').session;
  assert.match(session.instructions, /preferred_language/);
  assert.match(session.delegation.responses.instructions, /Klingon for klingon/);
  assert.ok(session.delegation.responses.tools.some(t => t.name === 'load_crew_profile'));
  assert.ok(session.delegation.responses.tools.some(t => t.name === 'lookup_repair'));
  assert.doesNotMatch(JSON.stringify(f.models[0].sent), /Avery|Chen|Wayfinder|HF-038|12025550123/);
  assert.equal((await invoke(f, 'get_case_brief', {}, 'before-auth')).error.code, 'profile_required');
  const loaded = await invoke(f, 'load_crew_profile', { spoken_code: DEMO.authCode }, 'auth');
  assert.equal(loaded.state, 'demo profile loaded'); assert.match(loaded.next_action, /Ask whether/);
  assert.equal(loaded.preferred_language, 'english');
  let interaction = (await repo.transaction(tx => tx.find('interactions', { provider_sid: callSid })))[0];
  assert.equal(interaction.case_id, null);
  const resumed = await invoke(f, 'resume_case', { case_id: 'HF-038', caller_confirmed: true }, 'resume');
  assert.match(resumed.brief, /shipped via Subspace courier/);
  const repair = await invoke(f, 'lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold coffee' }, 'repair');
  assert.equal(repair.ok, true); assert.equal(repair.task_status, 'result_ready');
  assert.doesNotMatch(repair.next_action, /no part has been ordered/);
  // A new proposal must not erase the earlier caller's not_fixed report.
  assert.match((await invoke(f, 'get_case_brief', {}, 'brief')).brief, /not_fixed/);
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZcrm' })); await closed;
  await until(() => f.summaries.length === 1);
  interaction = (await repo.transaction(tx => tx.find('interactions', { provider_sid: callSid })))[0];
  assert.ok(interaction.ended_at); assert.equal(interaction.case_id, 'HF-038');
  const events = await repo.transaction(tx => tx.find('case_events', { interaction_id: interaction.id }));
  assert.equal(events.filter(e => e.kind === 'call_ended').length, 1);
  assert.doesNotMatch(JSON.stringify([f.models[0].sent, f.summaries]), /12025550123|auth_code_hash/);
});
test('database failure leaves the mocked voice bridge and fictional repair tools usable', async t => {
  const service = createCRMService({ transaction() { throw new Error('private database details'); } });
  const f = await fixture(t, service);
  const ws = await connectCall(f, '+12025550123');
  await until(() => f.models[0].sent.some(e => e.content?.includes("can't reach case records")));
  const loaded = await invoke(f, 'load_crew_profile', { spoken_code: DEMO.authCode }, 'unavailable');
  assert.equal(loaded.error.code, 'memory_unavailable');
  const repair = await invoke(f, 'lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' }, 'repair-no-memory');
  assert.equal(repair.ok, true); assert.equal(repair.memory.error.code, 'memory_unavailable');
  assert.doesNotMatch(JSON.stringify(f.models[0].sent), /private database|Wayfinder|Avery/);
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZcrm' })); await closed;
  await until(() => f.summaries.length === 1);
  assert.equal(f.summaries[0].finalized, true);
});

test('an explicit call budget permits returning calls but still rejects concurrent and over-budget calls', async t => {
  const f = await fixture(t, null, { callLimit: 2 });
  for (let n = 0; n < 2; n++) {
    const ws = await connectCall(f, '+12025550123', `CA${String(n + 2).repeat(32)}`);
    const busy = await webhook(f, { AccountSid: config.accountSid, CallSid: `CA${'9'.repeat(32)}` });
    assert.match(await busy.text(), /<Reject reason="busy"/);
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZcrm' })); await closed;
    await until(() => f.summaries.length === n + 1);
  }
  assert.equal(f.opened, 2);
  const exhausted = await webhook(f, { AccountSid: config.accountSid, CallSid: `CA${'8'.repeat(32)}` });
  assert.match(await exhausted.text(), /<Reject reason="busy"/);
});

test('outbound reply tickets: one signed use each, bound to the callee, busy answers politely, voice-off refuses', async t => {
  const f = await fixture(t);
  const to = '+12025550123', taskId = '00000000-0000-4000-8000-000000000042';
  assert.throws(() => f.app.registerCallback({ taskId: 'nope', to }));
  assert.throws(() => f.app.registerCallback({ taskId, to: '5551212' }));
  const ticket = f.app.registerCallback({ taskId, to });
  assert.equal(ticket.url, `https://voice.example.test/outbound-call?ticket=${ticket.ticket}`);
  const outbound = (params, { url = ticket.url, signed = true } = {}) => fetch(`${f.base}${new URL(url).pathname}${new URL(url).search}`, { method: 'POST', body: new URLSearchParams(params), headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(signed ? { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, url, params) } : {}) } });
  const params = { AccountSid: config.accountSid, CallSid: callSid, To: to, From: '+12025550100', Direction: 'outbound-api' };
  assert.equal((await outbound(params, { signed: false })).status, 403);
  const mismatch = f.app.registerCallback({ taskId, to });
  assert.equal((await outbound({ ...params, To: '+12025550199' }, { url: mismatch.url })).status, 403, 'callee mismatch');
  assert.equal((await outbound(params, { url: mismatch.url })).status, 403, 'a signed mismatch consumes the ticket');
  assert.equal((await outbound(params, { url: `https://voice.example.test/outbound-call?ticket=${'b'.repeat(48)}` })).status, 403, 'unknown ticket');
  assert.equal((await outbound(params, { url: `${ticket.url}&x=1` })).status, 403, 'extra query');
  const ok = await outbound(params); const xml = await ok.text();
  assert.equal(ok.status, 200); assert.match(xml, /<Connect><Stream url="wss:\/\/voice\.example\.test\/media-stream\/"><Parameter name="ticket" value="[a-f0-9]{48}"/);
  assert.equal((await outbound(params)).status, 403, 'ticket is single use');
  assert.equal(f.opened, 0);

  const busy = await fixture(t, null, { callLimit: 0 });
  const t2 = busy.app.registerCallback({ taskId, to });
  const r = await fetch(`${busy.base}/outbound-call?ticket=${t2.ticket}`, { method: 'POST', body: new URLSearchParams(params), headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, t2.url, params) } });
  assert.equal(r.status, 200); assert.match(await r.text(), /<Say>Federation Customer Service is busy[^<]*<\/Say><Hangup\/>/);

  const off = await fixture(t, null, { voiceEnabled: false });
  assert.throws(() => off.app.registerCallback({ taskId, to }), /disabled/);
  assert.equal((await fetch(`${off.base}/outbound-call?ticket=${'c'.repeat(48)}`, { method: 'POST' })).status, 404);
});
