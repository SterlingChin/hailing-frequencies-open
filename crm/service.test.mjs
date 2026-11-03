import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from './repo-memory.mjs';
import { hashAuthCode } from './service.mjs';
import { repositoryContract } from './contract-tests.mjs';
import { buildCaseBrief } from './brief.mjs';
import { requireLocalDatabase, requireConfirmedDatabase } from './env.mjs';

repositoryContract('memory', async () => new MemoryRepository());
test('spoken and compact authorization codes have the same hash', () => {
  assert.equal(hashAuthCode('CHEN-AVERY-A484B7'), hashAuthCode('Authorization, Chen, Avery, Alpha four eight four Beta seven'));
  assert.notEqual(hashAuthCode('CHEN-AVERY-A484B8'), hashAuthCode('CHEN-AVERY-A484B7'));
});
test('Avery’s new phrase supports Bravo and Echo and replaces the old code', () => {
  const spoken = 'Authorization, Chen, Avery, Alpha seven, Bravo nine, Echo two';
  assert.equal(hashAuthCode(spoken), hashAuthCode('CHEN-AVERY-A7B9E2'));
  assert.notEqual(hashAuthCode(spoken), hashAuthCode('CHEN-AVERY-A484B7'));
});
test('brief budgets preserve every category with long fields', () => {
  const brief = buildCaseBrief({ caseRecord: { id: 'HF-042', status: 'open', symptom: 's'.repeat(300), diagnosis: 'd'.repeat(300), diagnosis_status: 'confirmed_fixed', next_step: 'n'.repeat(300), opened_at: '2026-10-04', updated_at: '2026-10-04' },
    tasks: [{ status: 'working', specialist: 'engineering' }, { status: 'working', specialist: 'logistics' }],
    parts: [{ id: 'one', part_name: 'p'.repeat(100), carrier: 'c'.repeat(100), eta: '2026-10-12', status: 'shipped', updated_at: '2026-10-11' }],
    messages: [{ id: 'one', status: 'undelivered', requested_at: '2026-10-11' }] }, new Date('2026-10-11'));
  assert.ok(brief.length <= 600);
  for (const word of ['Symptom:', 'Diagnosis (confirmed_fixed)', 'Next:', 'Pending: 2', 'Part:', 'ETA tomorrow', 'Last SMS: undelivered']) assert.ok(brief.includes(word), word);
});
test('destructive fixtures reject remote databases and connection query overrides', () => {
  for (const url of ['postgres://example.invalid/demo', 'postgres://localhost/demo?host=remote', 'https://localhost/demo']) assert.throws(() => requireLocalDatabase(url));
});

test('remote seeding needs the exact hostname typed; loopback needs nothing; query overrides stay refused', () => {
  const remote = 'postgres://user:secret@roundhouse.proxy.rlwy.net:12345/railway';
  assert.throws(() => requireConfirmedDatabase(remote), /--remote-host/);
  assert.throws(() => requireConfirmedDatabase(remote, 'wrong.host'), /--remote-host/);
  assert.throws(() => requireConfirmedDatabase(remote, ''), /--remote-host/);
  assert.equal(requireConfirmedDatabase(remote, 'ROUNDHOUSE.proxy.rlwy.net'), remote);
  assert.equal(requireConfirmedDatabase('postgres://127.0.0.1:5432/x'), 'postgres://127.0.0.1:5432/x');
  assert.throws(() => requireConfirmedDatabase(`${remote}?sslmode=disable`, 'roundhouse.proxy.rlwy.net'), /query/);
  assert.throws(() => requireConfirmedDatabase('mysql://h/x', 'h'));
  assert.throws(() => requireConfirmedDatabase(undefined, 'h'), /required/);
});
