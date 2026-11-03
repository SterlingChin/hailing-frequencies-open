import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import twilio from 'twilio';
import WebSocket from 'ws';
import { createApplication } from './server.mjs';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { ROSTER, seedRoster } from '../crm/roster.mjs';
import { createDecisionsClient } from '../decisions/client.mjs';

// Entirely fictional rehearsal: loopback transport, in-memory CRM and injected
// provider doubles. These answers exercise wiring, not model calibration.
const answers = [
  { name: 'route', type: 'choice', choice: 'it', confidence: 0.99 },
  { name: 'resolvable_now', type: 'predicate', probability: 0.05 },
  { name: 'needs_more_details', type: 'predicate', probability: 0.30 },
  { name: 'urgency', type: 'score', score: 0.18, probabilities: [
    { label: 'routine', probability: 0.82 }, { label: 'elevated', probability: 0.18 },
    { label: 'urgent', probability: 0 }, { label: 'critical', probability: 0 },
  ] },
];
const tavi = ROSTER.find(person => person.display_name === 'Tavi Rourke');
const request = 'the stellar survey report will not open';
const callSid = `CA${'2'.repeat(32)}`, messageSid = `SM${'3'.repeat(32)}`;
const config = { publicOrigin: 'https://sciences.example.test', accountSid: `AC${'1'.repeat(32)}`,
  authToken: 'fictional-rehearsal-token', voiceEnabled: true, smsEnabled: true,
  decisionsEnabled: true, callbackEnabled: false };

async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail('Expected Sciences rehearsal state did not arrive');
}
function fakeVoiceModel() {
  const socket = new EventEmitter(); socket.readyState = 1; socket.sent = [];
  socket.send = raw => {
    const event = JSON.parse(raw); socket.sent.push(event);
    if (event.type === 'session.start') queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.started' }))));
    if (event.type === 'session.close') queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } }))));
  };
  socket.close = () => { if (socket.readyState !== 3) { socket.readyState = 3; socket.emit('close'); } };
  socket.terminate = socket.close;
  return socket;
}

for (const completesBeforeConsent of [false, true]) {
  test(`Sciences end to end with fakes: IT finishes ${completesBeforeConsent ? 'before' : 'after'} SMS consent`, async t => {
    const repo = new MemoryRepository(); await seedRoster(repo);
    const service = createCRMService(repo);
    const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
    // Rehearse a fresh dispatch after a failed prior attempt. Pending work is
    // now reused instead of creating another task for the same case and desk.
    const prior = (await rows('specialist_tasks', { case_id: 'HF-031' }))[0];
    await service.recordTaskResult({ taskId: prior.id, failed: true, result: { summary: 'Earlier fictional attempt failed.' } });
    const originalTasks = await rows('specialist_tasks', { case_id: 'HF-031' });
    const decisions = [], specialistCalls = [], sends = [], summaries = [];
    const specialistStarted = Promise.withResolvers(), releaseSpecialist = Promise.withResolvers();
    t.after(() => releaseSpecialist.resolve());
    const model = fakeVoiceModel();
    const client = createDecisionsClient({ apiKey: 'fixture-only', baseUrl: 'https://decisions.example.test/v1',
      fetch: async (url, init) => {
        assert.equal(url, 'https://decisions.example.test/v1/decisions');
        assert.equal(init.method, 'POST'); decisions.push(JSON.parse(init.body));
        return { status: 200, json: async () => ({ model: 'gpt-6-luna', answers }) };
      } });
    const app = createApplication({ config, crmService: service, decisionsClient: client,
      modelFactory: () => model, onSummary: summary => summaries.push(summary), bridgeOptions: { closeTimeoutMs: 100 },
      placeCall: () => assert.fail('No outbound voice call belongs in the SMS rehearsal'),
      specialists: { it: async task => {
        specialistCalls.push(task); specialistStarted.resolve(); await releaseSpecialist.promise;
        return { ok: true, result: { summary: 'Clearance lapsed at transfer; 24-hour pass issued.',
          next_step: 'Retry the stellar survey report.', source_id: 'fictional-sciences-rehearsal' } };
      } },
      sendSms: async args => { sends.push(args); return { sid: messageSid }; },
    });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    t.after(() => app.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = (path, params) => fetch(base + path, { method: 'POST', body: new URLSearchParams(params), headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, config.publicOrigin + path, params),
    } });
    const incoming = await post('/incoming-call', { AccountSid: config.accountSid, CallSid: callSid, From: tavi.phone });
    assert.equal(incoming.status, 200);
    const ticket = (await incoming.text()).match(/name="ticket" value="([a-f0-9]+)"/)[1];
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/media-stream/`, { headers: {
      'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, 'wss://sciences.example.test/media-stream/', {}),
    } });
    await once(ws, 'open');
    ws.send(JSON.stringify({ event: 'start', streamSid: 'MZsciences', start: { callSid, accountSid: config.accountSid,
      streamSid: 'MZsciences', customParameters: { ticket }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
    await until(() => model.sent.some(e => e.type === 'session.instructions.append'));
    let sequence = 0;
    const invoke = async (name, args) => {
      const id = `sciences-${++sequence}`;
      model.emit('message', Buffer.from(JSON.stringify({ type: 'response.event', event: { type: 'response.output_item.done', item: {
        type: 'function_call', status: 'completed', name, call_id: id, arguments: JSON.stringify(args),
      } } })));
      await until(() => model.sent.some(e => e.item?.call_id === id));
      return JSON.parse(model.sent.find(e => e.item?.call_id === id).item.output);
    };
    assert.equal((await invoke('route_request', { request })).error.code, 'profile_required');
    const profile = await invoke('load_crew_profile', { spoken_code: tavi.auth_code });
    assert.equal(profile.state, 'demo profile loaded');
    assert.equal(profile.crm_context.profile.display_name, 'Tavi Rourke');
    assert.equal(profile.crm_context.selected_case, null);
    assert.equal((await invoke('route_request', { request })).error.code, 'case_required');
    assert.equal((await invoke('resume_case', { case_id: 'HF-031', caller_confirmed: true })).ok, true);
    const routed = await invoke('route_request', { request });
    assert.equal(routed.outcome, 'queue'); assert.equal(routed.route, 'it'); assert.equal(routed.urgency, 'routine');
    assert.equal(specialistCalls.length, 0, 'Decisions does not dispatch an expert');
    // Explicit fake reporting actor consumes the proposed tool call. The queue
    // worker is only this fixture's fake MCP implementation, not an API trigger.
    assert.equal(routed.action.type, 'route_to_expert');
    assert.equal(routed.action.tool_call.name, 'expert_engineering');
    assert.deepEqual(JSON.parse(routed.action.tool_call.arguments.context), routed.context);
    void app.queue.run(routed.action.task_id);
    await specialistStarted.promise;
    assert.equal(decisions.length, 1); assert.equal(decisions[0].model, 'gpt-6-luna');
    assert.deepEqual(decisions[0].questions.map(q => q.name), ['route', 'resolvable_now', 'needs_more_details', 'urgency']);
    for (const fact of ['Tavi Rourke', 'sciences', 'HF-031', 'SC-9', request]) assert.ok(decisions[0].input.includes(fact));
    for (const secret of [tavi.phone, tavi.auth_code, 'auth_code_hash']) {
      assert.ok(!JSON.stringify(decisions).includes(secret)); assert.ok(!JSON.stringify(specialistCalls).includes(secret));
    }
    assert.equal(specialistCalls.length, 1); assert.equal(specialistCalls[0].case_id, 'HF-031');
    assert.deepEqual(specialistCalls[0].context, routed.crm_context);
    assert.ok(decisions[0].input.startsWith(routed.context.text));
    assert.equal(specialistCalls[0].assignment, `routine: ${request}`);
    const consent = { task_id: routed.task_id, channel: 'sms', caller_requested: true, caller_confirmed_destination: true };
    assert.equal((await invoke('request_reply', { ...consent, caller_confirmed_destination: false })).ok, false);
    if (completesBeforeConsent) {
      releaseSpecialist.resolve();
      await until(async () => (await rows('specialist_tasks', { id: routed.task_id }))[0].status === 'result_ready');
    }
    assert.equal(sends.length, 0, 'A preference or completed task does not authorize sending');
    const consented = await invoke('request_reply', consent);
    assert.equal(consented.ok, true); assert.equal(consented.channel, 'sms');
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZsciences' })); await closed;
    await until(() => summaries.length === 1);
    assert.equal(summaries[0].finalized, true);
    releaseSpecialist.resolve();
    await until(async () => (await rows('specialist_tasks', { id: routed.task_id }))[0].reply_outcome === 'submitted');
    assert.equal(sends.length, 1); assert.equal(sends[0].to, tavi.phone);
    assert.match(sends[0].body, /^HF-031 — fictional it result\./);
    assert.match(sends[0].body, /24-hour pass issued.*Retry the stellar survey report/);
    const messages = await rows('outbound_messages'); assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'submitted', 'A fake send acknowledgement is not delivery');
    const callbackPath = new URL(sends[0].statusCallback).pathname;
    const callback = await post(callbackPath, { AccountSid: config.accountSid, MessageSid: messageSid, MessageStatus: 'delivered' });
    assert.equal(callback.status, 204);
    assert.equal((await rows('outbound_messages'))[0].status, 'delivered');
    await Promise.all([app.queue.reply(routed.task_id), app.queue.reply(routed.task_id)]);
    assert.deepEqual(await app.queue.sweep(), []); assert.equal(sends.length, 1, 'Reply claims prevent duplicate sends');
    const interactions = await rows('interactions', { case_id: 'HF-031' });
    assert.ok(interactions.find(i => i.provider_sid === callSid).ended_at);
    assert.ok(interactions.find(i => i.channel === 'sms' && i.direction === 'outbound').ended_at);
    const taskEvents = (await rows('case_events', { case_id: 'HF-031' })).filter(e => e.data?.task_id === routed.task_id).map(e => e.kind);
    for (const kind of ['task_started', 'reply_requested', 'task_result', 'reply_claimed', 'reply_started', 'reply_outcome']) assert.ok(taskEvents.includes(kind), kind);
    assert.equal(taskEvents.filter(kind => kind === 'reply_claimed').length, 1);
    assert.equal((await rows('cases', { id: 'HF-031' }))[0].status, 'open');
    // A failed earlier attempt stays in history while the new one completes.
    const tasks = await rows('specialist_tasks', { case_id: 'HF-031' });
    assert.equal(tasks.length, originalTasks.length + 1);
    assert.deepEqual(tasks.filter(task => task.id !== routed.task_id), originalTasks);
    t.diagnostic('Tavi → HF-031 → IT/routine → consent → fictional result → one fake SMS → signed fake delivery → saved timeline; case remains open.');
  });
}
