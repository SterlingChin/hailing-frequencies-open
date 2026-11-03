import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createApplication } from './server.mjs';
import { loadConfig } from '../voice/config.mjs';
import { MemoryRepository } from '../crm/repo-memory.mjs';
import { seedRoster } from '../crm/roster.mjs';
import { hashAuthCode } from '../crm/service.mjs';
import { DEMO, seedDemo } from '../crm/seed.mjs';

const API_TOKEN = 'a'.repeat(48);

async function setup(t) {
  const repository = new MemoryRepository();
  await seedRoster(repository);
  await seedDemo(repository, { scenario: 'returning', phone: '+12025550123' });
  const app = createApplication({ config: loadConfig({ env: { CONTEXT_API_TOKEN: API_TOKEN, REPORTING_API_TOKEN: API_TOKEN } }), repository,
    modelFactory: () => { throw new Error('Provider must not be called'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1/caller-context`;
  const post = async (path, body, token = API_TOKEN) => {
    const response = await fetch(`${base}/${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, repository, post, base };
}

test('caller API requires the partner token, matching name and phrase before any context is returned', async t => {
  const { post, base } = await setup(t);
  assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 401);
  assert.equal((await post('start', { caller_phone: '+12025550123' }, 'wrong')).status, 401);
  const start = await post('start', { caller_phone: '+12025550123' });
  assert.equal(start.status, 201);
  assert.equal(start.body.state, 'authorization_required');
  assert.match(start.body.session_token, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(start.body), /Avery|HF-038|candidate|12025550123|crew_member_id/);
  const session_token = start.body.session_token;
  assert.deepEqual(await post('context', { session_token }), { status: 403, body: { error: 'authorization_required' } });
  assert.deepEqual(await post('authorize', { session_token, name: 'Avery Chen', authorization: 'wrong' }),
    { status: 401, body: { error: 'phrase_not_accepted' } });
  const loaded = await post('authorize', { session_token, name: 'Avery Chen', authorization: 'Alpha seven, Bravo nine, Echo two' });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.state, 'demo_profile_loaded');
  assert.equal(loaded.body.assurance, 'fictional_phrase_only');
  assert.equal(loaded.body.crew_member_id, DEMO.crewId);
  assert.equal(loaded.body.profile.display_name, 'Avery Chen');
  assert.equal(loaded.body.profile.open_cases[0].caseId, 'HF-038');
  assert.doesNotMatch(JSON.stringify(loaded.body), /auth_code|contact_points|12025550123|A7B9E2|Alpha seven/);
  const again = await post('context', { session_token });
  assert.equal(again.status, 200);
  assert.equal(again.body.profile.display_name, 'Avery Chen');
  assert.equal(again.body.crew_member_id, loaded.body.crew_member_id);
  assert.deepEqual(await post('end', { session_token }), { status: 200, body: { state: 'ended' } });
  assert.equal((await post('context', { session_token })).status, 401);
});

test('the identity response supplies the CRM primary key accepted by trusted Decisions intake', async t => {
  const { app, repository, post } = await setup(t);
  const { body: { session_token } } = await post('start', {});
  const identity = await post('authorize', { session_token, name: 'Avery Chen', authorization: 'Alpha seven, Bravo nine, Echo two' });
  assert.equal(identity.status, 200);
  const crew = await repository.transaction(tx => tx.find('crew_members', { display_name: 'Avery Chen' }));
  assert.equal(identity.body.crew_member_id, crew[0].id);
  const context = 'The reporter says the environmental console is offline.';
  const req = Readable.from([JSON.stringify({ crew_member_id: identity.body.crew_member_id, context })]);
  Object.assign(req, { method: 'POST', url: '/api/decisions', headers: {
    'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}`,
  } });
  const done = Promise.withResolvers(); let status;
  app.server.emit('request', req, { writeHead(value) { status = value; }, end(body) { done.resolve(JSON.parse(body)); } });
  const decision = await done.promise;
  assert.equal(status, 200);
  assert.equal(decision.reason, 'decisions_unavailable', 'provider remains disabled for this handoff check');
  assert.equal(decision.context.crew_member_id, crew[0].id);
  const saved = await repository.transaction(tx => tx.find('reporter_contexts', { id: decision.context_id }));
  assert.equal(saved[0].crew_member_id, crew[0].id);
  assert.equal(saved[0].body, context);
});

test('Michael Watson authorizes with the spoken phrase on the existing crew ID', async t => {
  const { post } = await setup(t);
  const { body: { session_token } } = await post('start', { caller_phone: '+12025550132' });
  assert.deepEqual(await post('authorize', { session_token, name: 'Dax Row', authorization: 'Row, Dax, five nine alpha' }),
    { status: 401, body: { error: 'phrase_not_accepted' } });
  const loaded = await post('authorize', { session_token, name: 'Michael Watson', authorization: 'Watson, Michael, five nine alpha' });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.crew_member_id, '00000000-0000-4000-8000-000000000102');
  assert.equal(loaded.body.profile.display_name, 'Michael Watson');
  assert.equal(loaded.body.profile.preferred_language, 'klingon');
  assert.equal((await post('end', { session_token })).status, 200);
});

test('Bethany Ann receives a crew ID after a correct phrase so Decisions can check her ship', async t => {
  const { post, repository } = await setup(t);
  const { body: { session_token } } = await post('start', { caller_phone: '+12025550139' });
  assert.deepEqual(await post('authorize', { session_token, name: 'Bethany Ann', authorization: 'wrong' }),
    { status: 401, body: { error: 'phrase_not_accepted' } });
  const loaded = await post('authorize', { session_token, name: 'Bethany Ann', authorization: 'Ann, Bethany, seven two alpha' });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.crew_member_id, '00000000-0000-4000-8000-000000000109');
  assert.equal(loaded.body.profile.ship, 'USS Nebraska');
  assert.equal((await post('context', { session_token })).status, 200);
  const interactions = await repository.transaction(tx => tx.find('interactions'));
  assert.equal(interactions.find(i => i.provider_sid.startsWith('context-api:')).crew_member_id, loaded.body.crew_member_id);
  assert.equal((await post('end', { session_token })).status, 200);
});

test('phrase attempts are capped and non-demo profiles cannot load through the partner API', async t => {
  const { repository, post } = await setup(t);
  const nonDemoId = '00000000-0000-4000-8000-000000009999';
  await repository.transaction(tx => tx.insert('crew_members', { id: nonDemoId, display_name: 'Real Person', rank: 'Lieutenant',
    ship: 'USS Wayfinder', language: 'English', auth_code_hash: hashAuthCode('REAL-PERSON-1234'), is_demo: false,
    created_at: new Date().toISOString() }));
  const { body: { session_token } } = await post('start', {});
  assert.equal((await post('authorize', { session_token, name: 'Real Person', authorization: 'REAL-PERSON-1234' })).status, 401);
  assert.equal((await post('authorize', { session_token, name: 'Wrong Name', authorization: 'Alpha seven, Bravo nine, Echo two' })).status, 401);
  assert.equal((await post('authorize', { session_token, name: 'Avery Chen', authorization: 'wrong' })).status, 401);
  assert.deepEqual(await post('authorize', { session_token, name: 'Avery Chen', authorization: 'Alpha seven, Bravo nine, Echo two' }),
    { status: 429, body: { error: 'attempt_limit' } });
  assert.equal((await post('context', { session_token })).status, 403);
});

test('API is absent without its service token; malformed requests fail closed', async t => {
  const app = createApplication({ config: loadConfig({ env: {} }) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1/caller-context`;
  assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 404);
  assert.throws(() => loadConfig({ env: { CONTEXT_API_TOKEN: 'short' } }), /at least 32/);
  const { post } = await setup(t);
  assert.deepEqual(await post('start', { caller_phone: '202-555-0131' }),
    { status: 400, body: { error: 'invalid_caller_phone' } });
  assert.deepEqual(await post('start', { unexpected: true }), { status: 400, body: { error: 'invalid_body' } });
  const { body: { session_token } } = await post('start', {});
  const valid = { session_token, name: 'Avery Chen', authorization: 'Alpha seven, Bravo nine, Echo two' };
  for (const name of [undefined, null, 7, '', '   ', 'x'.repeat(121)]) {
    assert.deepEqual(await post('authorize', { ...valid, name }), { status: 400, body: { error: 'invalid_name' } });
  }
  for (const authorization of [undefined, null, 7, '', '   ', 'x'.repeat(251)]) {
    assert.deepEqual(await post('authorize', { ...valid, authorization }), { status: 400, body: { error: 'invalid_phrase' } });
  }
  assert.deepEqual(await post('authorize', { session_token, spoken_phrase: 'CHEN-AVERY-A7B9E2' }),
    { status: 400, body: { error: 'invalid_body' } });
  assert.equal((await post('context', { session_token })).status, 403);
});

test('a valid phrase under the wrong name exposes no profile and cannot authorize the session', async t => {
  const { repository, post } = await setup(t);
  const { body: { session_token } } = await post('start', { caller_phone: '+12025550131' });
  for (const authorization of ['Alpha seven, Bravo nine, Echo two', 'CHEN-AVERY-A7B9E2']) {
    assert.deepEqual(await post('authorize', { session_token, name: 'Tavi Rourke', authorization }),
      { status: 401, body: { error: 'phrase_not_accepted' } });
    assert.equal((await post('context', { session_token })).status, 403);
    const interactions = await repository.transaction(tx => tx.find('interactions'));
    assert.equal(interactions.find(i => i.provider_sid.startsWith('context-api:')).crew_member_id, null);
  }
  const loaded = await post('authorize', { session_token, name: '  aVeRy   CHEN  ', authorization: 'Alpha seven, Bravo nine, Echo two' });
  assert.equal(loaded.status, 200); assert.equal(loaded.body.profile.display_name, 'Avery Chen');
  assert.equal((await post('authorize', { session_token, name: 'Tavi Rourke', authorization: 'ROURKE-TAVI-27A4B1' })).status, 409);
  const refreshed = (await post('context', { session_token })).body;
  assert.equal(refreshed.profile.display_name, 'Avery Chen');
  assert.equal(refreshed.crew_member_id, DEMO.crewId);
});
