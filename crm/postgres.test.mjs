import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { once } from 'node:events';
import { PostgresRepository, createPool } from './repo-postgres.mjs';
import { repositoryContract } from './contract-tests.mjs';
import { migrate } from '../scripts/db-migrate.mjs';
import { requireLocalDatabase } from './env.mjs';
import { createCallTools } from './tools.mjs';
import { createCRMService, hashAuthCode } from './service.mjs';
import { lookupRepair } from '../voice/config.mjs';
import { seedDemo } from './seed.mjs';
import { ROSTER } from './roster.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
async function postgres(t, { directory, expected = ['001_init.sql', '002_routes_and_replies.sql', '003_crew_roster.sql', '004_it_context.sql', '005_preferred_language.sql', '006_reporter_context.sql', '007_general_support_cases.sql', '008_dax_row_authorization.sql', '009_michael_watson_identity.sql'] } = {}) {
  requireLocalDatabase(connectionString);
  const schema = `crm_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(connectionString);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPool(connectionString, { options: `-c search_path=${schema}` });
  const repo = new PostgresRepository({ pool });
  t.after(async () => {
    await repo.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  assert.deepEqual(await migrate(pool, directory), expected);
  assert.deepEqual(await migrate(pool, directory), []);
  return repo;
}
if (!connectionString) {
  test('Postgres integration (set TEST_DATABASE_URL to a local database)', { skip: true }, () => {});
} else {
  repositoryContract('Postgres', postgres);
  test('Postgres: upgrading Access tasks to IT preserves their existing result and reply consent', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hfo-legacy-migrations-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const legacy = ['001_init.sql', '002_routes_and_replies.sql', '003_crew_roster.sql'];
    for (const file of legacy) await copyFile(new URL(`../db/migrations/${file}`, import.meta.url), join(directory, file));
    const repo = await postgres(t, { directory: pathToFileURL(`${directory}/`), expected: legacy });
    // Insert legacy rows without the new column to exercise the actual upgrade.
    const crewId = randomUUID(), contactId = randomUUID(), equipmentId = randomUUID();
    await repo.pool.query("INSERT INTO crew_members (id, display_name, rank, ship, auth_code_hash, language, is_demo, created_at) VALUES ($1,'Avery Chen','Commander','USS Wayfinder',$2,'English',true,now())", [crewId, 'a'.repeat(64)]);
    await repo.pool.query("INSERT INTO contact_points (id, crew_member_id, kind, value, label, created_at) VALUES ($1,$2,'phone','+12025550123','fixture',now())", [contactId, crewId]);
    await repo.pool.query("INSERT INTO equipment (id, crew_member_id, model, location) VALUES ($1,$2,'RPL-2400','Deck 7')", [equipmentId, crewId]);
    await repo.pool.query("INSERT INTO cases (id, crew_member_id, equipment_id, status, title, symptom, symptom_revision, diagnosis_status, opened_at, updated_at) VALUES ('HF-038',$1,$2,'open','Cold tea','Tea is cold',1,'none',now(),now())", [crewId, equipmentId]);
    await repo.pool.query("INSERT INTO specialist_tasks (id, case_id, specialist, assignment, symptom_revision, status, result, created_at, completed_at) VALUES ($1,'HF-038','engineering','Check temperature',1,'result_ready',$2,now(),now())", [randomUUID(), JSON.stringify({ summary: 'Calibration needed.' })]);
    const before = (await repo.pool.query("UPDATE specialist_tasks SET specialist='access', reply_channel='voice', reply_contact_point_id=(SELECT id FROM contact_points LIMIT 1), reply_consent_at=now() WHERE specialist='engineering' RETURNING *")).rows[0];
    assert.ok(before.result); assert.ok(before.reply_consent_at);
    await repo.pool.query("INSERT INTO crew_members (id, display_name, rank, ship, auth_code_hash, language, is_demo, created_at) VALUES ($1,'Dax Roe','Ensign','USS Wayfinder',$2,'English',true,now())", [ROSTER[1].id, hashAuthCode('Roe, Dax, five nine alpha')]);
    await repo.pool.query("UPDATE crew_members SET language='Klingon' WHERE display_name='Avery Chen'");
    assert.deepEqual(await migrate(repo.pool), ['004_it_context.sql', '005_preferred_language.sql', '006_reporter_context.sql', '007_general_support_cases.sql', '008_dax_row_authorization.sql', '009_michael_watson_identity.sql']);
    assert.deepEqual((await repo.pool.query('SELECT * FROM specialist_tasks WHERE id=$1', [before.id])).rows[0], { ...before, specialist: 'it', context_snapshot: null });
    assert.equal((await repo.pool.query("SELECT preferred_language FROM crew_members WHERE display_name='Avery Chen'")).rows[0].preferred_language, 'klingon');
    const dax = (await repo.pool.query('SELECT display_name, preferred_language FROM crew_members WHERE id=$1', [ROSTER[1].id])).rows[0];
    assert.equal(dax.display_name, 'Michael Watson');
    assert.equal(dax.preferred_language, 'klingon');
    assert.deepEqual(await migrate(repo.pool), []);
    await assert.rejects(repo.pool.query("UPDATE specialist_tasks SET context_snapshot='[]'::jsonb WHERE id=$1", [before.id]), { code: '23514' });
  });
  test('Postgres: Michael phrase migration updates the existing demo row and preserves contact history', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hfo-dax-migrations-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const prior = ['001_init.sql', '002_routes_and_replies.sql', '003_crew_roster.sql', '004_it_context.sql', '005_preferred_language.sql', '006_reporter_context.sql', '007_general_support_cases.sql'];
    for (const file of prior) await copyFile(new URL(`../db/migrations/${file}`, import.meta.url), join(directory, file));
    const repo = await postgres(t, { directory: pathToFileURL(`${directory}/`), expected: prior });
    await repo.pool.query("INSERT INTO crew_members (id, display_name, rank, ship, auth_code_hash, language, is_demo, created_at) VALUES ($1,'Dax Row','Ensign','USS Wayfinder',$2,'English',true,now())", [ROSTER[1].id, hashAuthCode('Roe, Dax, five nine alpha')]);
    const interactionId = randomUUID();
    await repo.pool.query("INSERT INTO interactions (id, crew_member_id, channel, direction, provider_sid, auth_attempts, started_at, ended_at) VALUES ($1,$2,'voice','inbound','dax-history-test',1,now(),now())", [interactionId, ROSTER[1].id]);
    assert.deepEqual(await migrate(repo.pool), ['008_dax_row_authorization.sql', '009_michael_watson_identity.sql']);
    const row = (await repo.pool.query('SELECT id, display_name, auth_code_hash FROM crew_members WHERE id=$1', [ROSTER[1].id])).rows[0];
    assert.equal(row.display_name, 'Michael Watson');
    assert.equal(row.auth_code_hash, hashAuthCode('Watson, Michael, five nine alpha'));
    assert.equal((await repo.pool.query('SELECT crew_member_id FROM interactions WHERE id=$1', [interactionId])).rows[0].crew_member_id, row.id);
    assert.deepEqual(await migrate(repo.pool), []);
  });
  test('Postgres: reporter context migration enforces crew/case ownership and blob bounds', async t => {
    const repo = await postgres(t);
    await seedDemo(repo, { scenario: 'returning', phone: '+12025550123' });
    const original = (await repo.pool.query('SELECT id FROM crew_members LIMIT 1')).rows[0].id;
    const other = randomUUID();
    await repo.pool.query("INSERT INTO crew_members (id, display_name, rank, ship, auth_code_hash, language, created_at) VALUES ($1,'Other','x','x',$2,'English',now())", [other, 'f'.repeat(64)]);
    const caseId = (await repo.pool.query('SELECT id FROM cases LIMIT 1')).rows[0].id;
    const insert = (id, body, caseRef = null) => repo.pool.query('INSERT INTO reporter_contexts (id, crew_member_id, case_id, body, created_at) VALUES ($1,$2,$3,$4,now())', [randomUUID(), id, caseRef, body]);
    await assert.rejects(insert(randomUUID(), 'Unknown crew'), { code: '23503' });
    await assert.rejects(insert(other, 'Wrong case owner', caseId), { code: '23503' });
    await assert.rejects(insert(original, 'x'.repeat(64001)), { code: '23514' });
    await insert(original, 'Saved conversation', caseId);
    assert.equal((await repo.pool.query('SELECT count(*)::int AS n FROM reporter_contexts')).rows[0].n, 1);
  });
  test('Postgres: migration checksum detects edits and SQL constraints reject invalid records', async t => {
    const repo = await postgres(t);
    await assert.rejects(repo.pool.query("INSERT INTO crew_members (id, display_name, rank, ship, auth_code_hash, language, created_at) VALUES ($1,'x','x','x','not-a-hash','English',now())", [randomUUID()]), { code: '23514' });
    await assert.rejects(repo.pool.query("INSERT INTO crew_members (id, display_name, rank, ship, auth_code_hash, language, preferred_language, created_at) VALUES ($1,'x','x','x',$2,'English','vulcan',now())", [randomUUID(), 'a'.repeat(64)]), { code: '23514' });
    await repo.pool.query("UPDATE schema_migrations SET checksum='changed'");
    await assert.rejects(migrate(repo.pool), /Applied migration changed/);
    assert.equal((await repo.pool.query('SELECT count(*)::int AS n FROM crew_members')).rows[0].n, 0);
  });
  test('Postgres: the seed CLI actually runs each scenario and migration CLI reruns cleanly', async t => {
    const repo = await postgres(t);
    const schema = (await repo.pool.query('SHOW search_path')).rows[0].search_path;
    const env = { ...process.env, DATABASE_URL: connectionString, DEMO_CALLER_E164: '+12025550123', PGOPTIONS: `-c search_path=${schema}` };
    const run = promisify(execFile);
    for (const [scenario, expected] of [['fresh', 0], ['returning', 1], ['two_open', 2]]) {
      const result = await run(process.execPath, ['crm/seed.mjs', '--scenario', scenario], { env });
      assert.equal(result.stdout.trim(), `Fictional scenario loaded: ${scenario}.`);
      assert.equal((await repo.pool.query('SELECT count(*)::int AS n FROM cases')).rows[0].n, expected);
    }
    const roster = await run(process.execPath, ['crm/roster.mjs'], { env });
    assert.equal(roster.stdout.trim(), 'Fictional roster loaded: 9 crew.');
    assert.equal((await repo.pool.query('SELECT count(*)::int AS n FROM crew_members')).rows[0].n, 10);
    assert.equal((await run(process.execPath, ['crm/roster.mjs'], { env })).stdout.trim(), 'Fictional roster loaded: 9 crew.');
    assert.equal((await repo.pool.query('SELECT count(*)::int AS n FROM crew_members')).rows[0].n, 10);
    const result = await run(process.execPath, ['scripts/db-migrate.mjs'], { env });
    assert.equal(result.stdout.trim(), 'Migrations applied: 0.');
  });
}

test('real local connection refusal produces a safe memory-unavailable response', { skip: !connectionString }, async t => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const local = new URL('postgresql://127.0.0.1'); local.port = String(port); local.pathname = '/unavailable_fixture';
  const repo = new PostgresRepository({ pool: createPool(local.href, { connectionTimeoutMillis: 100 }) });
  t.after(() => repo.close());
  const tools = createCallTools({ service: createCRMService(repo), context: { callSid: 'refused-fixture', fromE164: null }, lookupRepair });
  assert.equal(await tools.ready, false);
  assert.match(await tools.startupInstruction(), /can't reach case records/);
  assert.equal((await tools.handle('load_crew_profile', { spoken_code: 'fictional' })).error.code, 'memory_unavailable');
  assert.equal((await tools.handle('lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' })).ok, true);
  await tools.end();
});
