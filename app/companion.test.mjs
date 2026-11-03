import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from './server.mjs';
import { fixtureFrames } from './fixtures.mjs';

async function setup(t, companionOptions = { intervalMs: 2, heartbeatMs: 20 }) {
  const app = createApplication({ config: { voiceEnabled: false, smsEnabled: false }, companionOptions,
    modelFactory: () => assert.fail('no live model'), sendSms: () => assert.fail('no sends') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
test('same server serves only allowlisted companion assets and no CRM or secret files', async t => {
  const f = await setup(t);
  const html = await fetch(f.base); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /connect-src 'self'/);
  const body = await html.text(); assert.match(body, /Fixture preview/); assert.match(body, /design-system\/tokens.css/); assert.match(body, /design-system\/components.css/);
  for (const asset of ['/web/app.js', '/web/app.css', '/design-system/tokens.css', '/design-system/components.css']) assert.equal((await fetch(f.base + asset)).status, 200);
  for (const path of ['/.env', '/crm/service.mjs', '/api/cases/HF-038', '/api/crew/test/cases', '/design-system/reference/DESIGN-BRIEF.md', '/%2e%2e/.env', '/web/../.env']) assert.equal((await fetch(f.base + path)).status, 404);
});
test('SSE streams ordered fixture state through captions, specialists, case and fallback; no invented delivery', async t => {
  const f = await setup(t);
  const stream = await fetch(f.base + '/events?scenario=repair');
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  const raw = await stream.text();
  const snapshots = [...raw.matchAll(/event: snapshot\ndata: (.+)/g)].map(m => JSON.parse(m[1]));
  assert.deepEqual(snapshots, fixtureFrames('repair'));
  assert.ok(snapshots.every(s => s.source === 'fixture' && s.message.status !== 'delivered'));
  assert.equal(snapshots.at(-1).connection, 'ended'); assert.equal(snapshots.at(-1).case.status, 'open');
  assert.match(snapshots.at(-1).message.summary, /Possible cause/); assert.match(raw, /event: complete/);
});
test('SSE resumes by scenario-scoped event ID and refuses unknown fixtures', async t => {
  const f = await setup(t);
  const raw = await (await fetch(f.base + '/events?scenario=repair', { headers: { 'Last-Event-ID': 'repair:8' } })).text();
  assert.match(raw, /^id: repair:9/); assert.doesNotMatch(raw, /^id: repair:0/m);
  assert.equal((await fetch(f.base + '/events?scenario=private')).status, 400);
  const paused = await (await fetch(f.base + '/events?scenario=repair&after=repair:8')).text();
  assert.match(paused, /^id: repair:9/);
});
test('SSE shutdown closes active clients promptly', async t => {
  const f = await setup(t, { intervalMs: 60000, heartbeatMs: 60000 });
  const stream = await fetch(f.base + '/events'); const reader = stream.body.getReader(); await reader.read();
  await f.app.close(); assert.equal((await reader.read()).done, true);
});
test('fixture corrections replace stale results and returning history does not attach before confirmation', () => {
  const revised = fixtureFrames('revised').at(-1);
  assert.equal(revised.tasks[0].status, 'obsolete'); assert.equal(revised.case.revision, 2); assert.equal(revised.case.diagnosisStatus, 'none');
  const returning = fixtureFrames('returning');
  assert.equal(returning[2].case, null); assert.equal(returning[3].case.id, 'HF-038');
  assert.match(returning.at(-1).nextStep.text, /Subspace courier/);
});
