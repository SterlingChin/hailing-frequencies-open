import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../voice/config.mjs';
import { createApplication } from './server.mjs';
import { once } from 'node:events';

test('environment-only config defaults to safe loopback fixtures; PORT binds all interfaces', () => {
  const local = loadConfig({ env: {} });
  assert.equal(local.port, 8788); assert.equal(local.host, '127.0.0.1');
  assert.equal(local.voiceEnabled, false); assert.equal(local.smsEnabled, false);
  assert.equal(local.databaseUrl, null);
  assert.equal(loadConfig({ env: { PORT: '8080' } }).host, '0.0.0.0');
  assert.equal(loadConfig({ env: { PORT: '8080', HOST: '127.0.0.1' } }).host, '127.0.0.1');
  for (const PORT of ['0', '-1', '65536', '1.5', 'wat']) assert.throws(() => loadConfig({ env: { PORT } }));
  assert.throws(() => loadConfig({ env: { NODE_ENV: 'production' } }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ env: { VOICE_ENABLED: 'true' } }), /OPENAI_API_KEY/);
  assert.throws(() => loadConfig({ env: { SMS_ENABLED: 'true' } }), /TWILIO_SMS_FROM/);
  assert.equal(local.decisionsEnabled, false);
  assert.throws(() => loadConfig({ env: { DECISIONS_ENABLED: 'true' } }), /OPENAI_API_KEY/);
  assert.equal(loadConfig({ env: { DECISIONS_ENABLED: 'true', OPENAI_API_KEY: 'sk-fixture' } }).decisionsEnabled, true);
  assert.equal(local.callbackEnabled, false);
  assert.throws(() => loadConfig({ env: { CALLBACK_ENABLED: 'true' } }), /requires VOICE_ENABLED/);
  const voice = { VOICE_ENABLED: 'true', OPENAI_API_KEY: 'k', TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 't', TWILIO_VOICE_PUBLIC_DOMAIN: 'https://voice.example.test', DATABASE_URL: 'postgres://x' };
  assert.throws(() => loadConfig({ env: { ...voice, CALLBACK_ENABLED: 'true' } }), /TWILIO_VOICE_FROM/);
  assert.throws(() => loadConfig({ env: { ...voice, CALLBACK_ENABLED: 'true', TWILIO_VOICE_FROM: '555' } }), /E\.164/);
  assert.equal(loadConfig({ env: { ...voice, CALLBACK_ENABLED: 'true', TWILIO_VOICE_FROM: '+12025550100' } }).voiceFrom, '+12025550100');
  assert.throws(() => loadConfig({ env: { VOICE_ENABLED: 'yes' } }));
  assert.throws(() => loadConfig({ env: { TWILIO_VOICE_PUBLIC_DOMAIN: 'https://example.test/path' } }));
});

test('health reports DB readiness without revealing errors or calling providers', async t => {
  let unavailable = false, providerCalls = 0;
  const app = createApplication({ config: loadConfig({ env: {} }),
    repository: { pool: { query: async () => { if (unavailable) throw new Error('private database URL'); } } },
    crmService: {}, modelFactory: () => { providerCalls++; throw new Error('forbidden'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  unavailable = true;
  const down = await fetch(`${base}/health`);
  assert.equal(down.status, 503); assert.doesNotMatch(await down.text(), /private/);
  assert.equal((await fetch(`${base}/incoming-call`, { method: 'POST' })).status, 404);
  assert.equal(providerCalls, 0);
});
