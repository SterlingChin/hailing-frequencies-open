import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import twilio from 'twilio';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { createCRMService } from '../crm/service.mjs';
import { createCallTools } from '../crm/tools.mjs';
import { seedDemo, DEMO } from '../crm/seed.mjs';
import { lookupRepair } from '../voice/config.mjs';
import { createSmsFollowup } from './followup.mjs';
import { createApplication } from '../app/server.mjs';

const PHONE = '+12025550123';
const SID = `SM${'3'.repeat(32)}`;
const config = { voiceEnabled: false, smsEnabled: true, publicOrigin: 'https://fixture.example.test', accountSid: `AC${'1'.repeat(32)}`, authToken: 'fixture-token', smsFrom: '+12025550124' };
async function setup(t, { send, enabled = true } = {}) {
  const repo = new MemoryRepository(); await seedDemo(repo, { scenario: 'fresh', phone: PHONE });
  const service = createCRMService(repo), requests = [];
  const sender = send ?? (async args => { requests.push(args); return { sid: SID }; });
  const followup = createSmsFollowup({ service, config: { ...config, smsEnabled: enabled }, send: sender });
  const context = { callSid: 'sms-fixture', fromE164: PHONE };
  const tools = createCallTools({ service, context, lookupRepair, smsFollowup: followup });
  t.after(() => tools.end());
  const rows = (table, where = {}) => repo.transaction(tx => tx.find(table, where));
  const open = async () => {
    await tools.handle('load_crew_profile', { spoken_code: DEMO.authCode });
    await tools.handle('open_case', { equipment_id: DEMO.equipmentId, symptom: 'coffee cold' });
    await tools.handle('lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' });
  };
  const ask = () => tools.handle('request_repair_sms', { caller_requested: true, caller_confirmed_destination: true });
  return { repo, service, followup, context, tools, rows, requests, open, ask };
}
test('preferences and false/missing consent never create a message or send; destination is bound to the loaded caller', async t => {
  const f = await setup(t); assert.equal((await f.ask()).error.code, 'profile_required'); await f.open();
  for (const args of [{}, { caller_requested: false, caller_confirmed_destination: true }, { caller_requested: true, caller_confirmed_destination: false }, { caller_requested: true, caller_confirmed_destination: true, to: '+12025550199' }]) {
    assert.equal((await f.tools.handle('request_repair_sms', args)).ok, false);
  }
  assert.equal(f.requests.length, 0); assert.equal((await f.rows('outbound_messages')).length, 0);
  const missing = await f.followup.request({ interactionId: f.context.interactionId, fromE164: '+12025550199', explicitRequest: true, confirmedDestination: true });
  assert.equal(missing.status, 'unavailable'); assert.match(missing.summary, /Possible cause/); assert.equal(f.requests.length, 0);
});
test('parallel explicit requests send once; another adapter instance cannot repeat a claimed request', async t => {
  const f = await setup(t); await f.open();
  const args = { interactionId: f.context.interactionId, fromE164: PHONE, explicitRequest: true, confirmedDestination: true };
  await Promise.all([f.followup.request(args), f.followup.request(args)]);
  const result = await f.ask();
  assert.equal(f.requests.length, 1); assert.equal(result.status, 'submitted');
  assert.equal(f.requests[0].to, PHONE); assert.match(f.requests[0].body, /HF-042.*Possible cause/);
  assert.match(f.requests[0].statusCallback, /^https:\/\/fixture.example.test\/sms\/status\//);
  assert.doesNotMatch(JSON.stringify(result), /12025550123|provider_sid|authToken/);
  const restarted = createSmsFollowup({ service: f.service, config, send: async () => assert.fail('duplicate send') });
  await restarted.request(args);
  assert.equal((await f.rows('outbound_messages')).length, 1);
});
test('disabled SMS and definite rejection preserve the summary; unknown send outcome is never retried', async t => {
  const disabled = await setup(t, { enabled: false }); await disabled.open();
  assert.equal((await disabled.ask()).status, 'requested'); assert.equal(disabled.requests.length, 0);
  const rejected = await setup(t, { send: async () => { throw Object.assign(new Error('private details'), { status: 400, code: 21610 }); } }); await rejected.open();
  const failed = await rejected.ask(); assert.equal(failed.status, 'failed'); assert.equal(failed.fallback, true);
  assert.doesNotMatch(JSON.stringify(failed), /private details/);
  let attempts = 0;
  const uncertain = await setup(t, { send: async () => { attempts++; throw new Error('timeout'); } }); await uncertain.open();
  assert.match((await uncertain.ask()).message, /outcome is unknown/); await uncertain.ask(); assert.equal(attempts, 1);
});
test('callback before create response wins, and later submitted does not overwrite delivered', async t => {
  let f;
  f = await setup(t, { send: async args => {
    const id = args.statusCallback.split('/').at(-1);
    await f.service.recordMessageStatus({ messageId: id, status: 'delivered', providerSid: SID });
    return { sid: SID };
  } });
  await f.open(); assert.equal((await f.ask()).status, 'delivered');
});
test('signed status callbacks enforce origin/account/SID, retain out-of-order history, and never send', async t => {
  const f = await setup(t); await f.open(); await f.ask();
  const [message] = await f.rows('outbound_messages');
  const app = createApplication({ config, crmService: f.service, sendSms: async () => assert.fail('callback must not send') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const path = `/sms/status/${message.id}`;
  const post = async (params, { signed = true, origin = config.publicOrigin, suffix = '', type = 'application/x-www-form-urlencoded' } = {}) => fetch(base + path + suffix, {
    method: 'POST', body: new URLSearchParams(params), headers: { 'Content-Type': type, 'X-Forwarded-Host': 'attacker.test',
      ...(signed ? { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.authToken, origin + path + suffix, params) } : {}) } });
  const params = { AccountSid: config.accountSid, MessageSid: SID, MessageStatus: 'delivered', FutureParameter: 'included-in-signature' };
  assert.equal((await post(params, { signed: false })).status, 403);
  assert.equal((await post(params, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post({ ...params, AccountSid: `AC${'9'.repeat(32)}` })).status, 403);
  assert.equal((await post(params, { type: 'application/json' })).status, 415);
  assert.equal((await post(params, { suffix: '?extra=true' })).status, 404);
  assert.equal((await post({ ...params, MessageStatus: 'invented' })).status, 400);
  assert.equal((await post(params)).status, 204);
  assert.equal((await post({ ...params, MessageStatus: 'sent' })).status, 204);
  assert.equal((await post(params)).status, 204);
  assert.equal((await post({ ...params, MessageSid: `SM${'8'.repeat(32)}` })).status, 409);
  const [current] = await f.rows('outbound_messages');
  assert.equal(current.status, 'delivered'); assert.deepEqual(current.status_history.slice(-3).map(s => s.status), ['delivered', 'sent', 'delivered']);
  assert.equal(f.requests.length, 1);
});
