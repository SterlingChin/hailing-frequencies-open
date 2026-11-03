import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPool } from '../crm/repo-postgres.mjs';
import { readLocalEnv } from '../crm/env.mjs';

export async function migrate(pool, directory = new URL('../db/migrations/', import.meta.url)) {
  const files = (await readdir(directory)).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4847002)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = (await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file])).rows[0];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error('Applied migration changed');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [file, checksum]);
      applied.push(file);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function main() {
  const env = await readLocalEnv();
  const pool = createPool(env.DATABASE_URL);
  try { console.log(`Migrations applied: ${(await migrate(pool)).length}.`); }
  finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Migration failed. Check database configuration and migration files; connection details are withheld.'); process.exitCode = 1; });
}
