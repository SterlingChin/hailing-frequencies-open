import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { DEMO, seedDemo } from '../crm/seed.mjs';
import { NOW, PHONE } from '../crm/contract-tests.mjs';
import { createQueueWorker } from './worker.mjs';
import { createSmsReply } from '../reply/sms.mjs';
import { createCallReply } from '../reply/call.mjs';

const SMS_SID = `SM${'7'.repeat(32)}`, CALL_SID = `CA${'8'.repeat(32)}`;
const config = { smsEnabled: true, callbackEnabled: true, publicOrigin: 'https://fixture.example.test', voiceFrom: '+12025550100' };
async function fixture({ channel, specialist = 'access', sms = {}, call = {}, handlers } = {}) {
  const repo = new MemoryRepository(); await seedDemo(repo, { scenario: 'fresh', phone: PHONE, now: NOW });
  const service = createCRMService(repo, { now: () => NOW });
  const i = await service.beginInteraction({ providerSid: 'queue-fixture' });
  await service.loadProfileByAuthCode({ spokenCode: DEMO.authCode, interactionId: i.id });
  await service.openCase({ interactionId: i.id, equipmentId: DEMO.equipmentId, symptom: 'cannot open the science report' });
  const task = await service.startTask({ interactionId: i.id, specialist, assignment: 'elevated: cannot open the science report' });
  if (channel) await service.recordReplyConsent({ interactionId: i.id, taskId: task.id, channel, fromE164: PHONE, explicitRequest: true, confirmedDestination: true });
  await service.endInteraction(i.id);
  const sent = [], placed = [], tickets = [];
  const send = sms.send ?? (async args => { sent.push(args); return { sid: SMS_SID }; });
  const place = call.place ?? (async args => { placed.push(args); return { sid: CALL_SID }; });
  const registerCallback = ({ taskId, to }) => { const ticket = { taskId, to, url: `${config.publicOrigin}/outbound-call?ticket=${'a'.repeat(48)}` }; tickets.push(ticket); return ticket; };
  const replies = { sms: createSmsReply({ service, config: { ...config, ...sms.config }, send: sms.enabled === false ? null : send }),
    voice: createCallReply({ service, config: { ...config, ...call.config }, place: call.enabled === false ? null : place, registerCallback }) };
  const specialists = handlers ?? { access: async payload => ({ ok: true, result: { summary: `Clearance for ${payload.equipment_model} lapsed at transfer; 24-hour pass issued.`, next_step: 'Retry the report.' } }) };
  const worker = createQueueWorker({ service, specialists, replies });
  const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
  return { service, task, worker, sent, placed, tickets, rows };
}

test('worker runs the specialist, records a bounded result, then texts the consented number exactly once', async () => {
  const f = await fixture({ channel: 'sms' });
  const run = await f.worker.run(f.task.id);
  assert.equal(run.status, 'result_ready'); assert.equal(run.reply.channel, 'sms'); assert.equal(run.reply.status, 'submitted');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, PHONE); assert.match(f.sent[0].body, /fictional access result\. Clearance for RPL-2400 lapsed/);
  assert.match(f.sent[0].statusCallback, /^https:\/\/fixture\.example\.test\/sms\/status\/[0-9a-f-]{36}$/);
  const task = (await f.rows('specialist_tasks', { id: f.task.id }))[0];
  assert.equal(task.reply_outcome, 'submitted'); assert.equal(task.reply_provider_sid, SMS_SID); assert.ok(task.reply_claimed_at);
  const messages = await f.rows('outbound_messages'); assert.equal(messages.length, 1); assert.equal(messages[0].status, 'submitted');
  const outbound = (await f.rows('interactions', { direction: 'outbound' }))[0];
  assert.equal(outbound.channel, 'sms'); assert.ok(outbound.ended_at); assert.equal(messages[0].requested_in_interaction_id, outbound.id);
  assert.equal((await f.worker.run(f.task.id)).error.code, 'task_not_pending');
  const again = await f.worker.reply(f.task.id);
  assert.equal(again.status, 'submitted'); assert.match(again.message, /already attempted/); assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.worker.sweep(), []);
});
test('voice reply registers a one-time ticket and places one call; a definite rejection is recorded, an ambiguous one is not retried', async () => {
  const f = await fixture({ channel: 'voice' });
  const run = await f.worker.run(f.task.id);
  assert.equal(run.reply.status, 'placed'); assert.equal(f.placed.length, 1); assert.equal(f.placed[0].to, PHONE);
  assert.equal(f.tickets[0].taskId, f.task.id); assert.equal(f.placed[0].url, f.tickets[0].url);
  assert.equal((await f.rows('specialist_tasks', { id: f.task.id }))[0].reply_provider_sid, CALL_SID);
  assert.match((await f.worker.reply(f.task.id)).message, /already attempted/); assert.equal(f.placed.length, 1);

  const rejected = await fixture({ channel: 'voice', call: { place: async () => { throw Object.assign(new Error('bad number'), { status: 400, code: 21211 }); } } });
  assert.equal((await rejected.worker.run(rejected.task.id)).reply.status, 'failed');
  assert.equal((await rejected.rows('specialist_tasks', { id: rejected.task.id }))[0].reply_outcome, 'failed');

  let attempts = 0;
  const ambiguous = await fixture({ channel: 'voice', call: { place: async () => { attempts++; throw new Error('socket hang up'); } } });
  const outcome = await ambiguous.worker.run(ambiguous.task.id);
  assert.equal(outcome.reply.status, 'unknown'); assert.equal(attempts, 1);
  assert.match((await ambiguous.worker.reply(ambiguous.task.id)).message, /already attempted/); assert.equal(attempts, 1);
  assert.equal((await ambiguous.rows('specialist_tasks', { id: ambiguous.task.id }))[0].reply_outcome, null);
});
test('disabled channels send nothing and keep the reply due; missing specialists and bad results are recorded as failed', async () => {
  const off = await fixture({ channel: 'sms', sms: { enabled: false } });
  const run = await off.worker.run(off.task.id);
  assert.equal(run.reply.status, 'unavailable'); assert.equal(off.sent.length, 0);
  assert.equal((await off.rows('specialist_tasks', { id: off.task.id }))[0].reply_claimed_at, null);
  assert.equal((await off.worker.sweep())[0].status, 'unavailable');
  assert.equal((await off.rows('outbound_messages')).length, 0);
  const callOff = await fixture({ channel: 'voice', call: { config: { callbackEnabled: false } } });
  assert.equal((await callOff.worker.run(callOff.task.id)).reply.status, 'unavailable'); assert.equal(callOff.placed.length, 0);
  const none = await fixture({ channel: null });
  assert.equal((await none.worker.run(none.task.id)).reply, null);
  await assert.rejects(none.worker.reply(none.task.id), { code: 'reply_not_requested' });
  const missing = await fixture({ channel: 'sms', handlers: {} });
  assert.equal((await missing.worker.run(missing.task.id)).error.code, 'specialist_unavailable');
  assert.equal((await missing.rows('specialist_tasks', { id: missing.task.id }))[0].status, 'working');
  for (const handler of [async () => { throw new Error('mcp down'); }, async () => ({ ok: true, result: { transcript: 'x'.repeat(5000) } }), async () => null]) {
    const bad = await fixture({ channel: 'sms', handlers: { access: handler } });
    const result = await bad.worker.run(bad.task.id);
    assert.equal(result.status, 'failed'); assert.equal(result.reply, null); assert.equal(bad.sent.length, 0);
    assert.equal((await bad.rows('specialist_tasks', { id: bad.task.id }))[0].result.summary, 'The access desk could not finish this request.');
  }
});
