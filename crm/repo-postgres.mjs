import pg from 'pg';
import { validateColumns, caseId } from './repo-shared.mjs';

const rowJSON = row => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
const sqlValue = (key, value) => ['data', 'result', 'status_history', 'context_snapshot'].includes(key) && value != null ? JSON.stringify(value) : value;
export function createPool(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString?.trim()) throw new Error('Missing variable: DATABASE_URL');
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 1500,
    statement_timeout: 5000, idle_in_transaction_session_timeout: 10000, ...options });
  // Raw driver errors can contain credentials or private data. Callers report safe codes.
  pool.on('error', () => {});
  return pool;
}
export class PostgresRepository {
  constructor({ pool, connectionString } = {}) { this.pool = pool ?? createPool(connectionString); }
  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Small-demo serialization: every service mutation and its event commit together.
      // This also prevents stale result races and duplicate message requests across workers.
      await client.query('SELECT pg_advisory_xact_lock(4847001)');
      const tx = {
        async find(table, where = {}) {
          validateColumns(table, where);
          const keys = Object.keys(where);
          const sqlWhere = keys.length ? ` WHERE ${keys.map((k, i) => `"${k}" IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}` : '';
          return (await client.query(`SELECT * FROM "${table}"${sqlWhere}`, keys.map(k => sqlValue(k, where[k])))).rows.map(rowJSON);
        },
        async insert(table, row) {
          validateColumns(table, row);
          const keys = Object.keys(row);
          const result = await client.query(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, keys.map(k => sqlValue(k, row[k])));
          return rowJSON(result.rows[0]);
        },
        async update(table, id, patch) {
          validateColumns(table, patch);
          const keys = Object.keys(patch);
          const result = await client.query(`UPDATE "${table}" SET ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map(k => sqlValue(k, patch[k])), id]);
          return rowJSON(result.rows[0]);
        },
        async remove(table, where) {
          validateColumns(table, where);
          const keys = Object.keys(where);
          if (!keys.length) throw new Error('Scoped delete required');
          await client.query(`DELETE FROM "${table}" WHERE ${keys.map((k, i) => `"${k}" IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}`, keys.map(k => where[k]));
        },
        async nextCaseId() { return caseId((await client.query("SELECT nextval('case_number_seq') AS n")).rows[0].n); },
        async resetCaseSequence() {
          await client.query("SELECT setval('case_number_seq', GREATEST(41, COALESCE((SELECT max(substring(id FROM 4)::bigint) FROM cases), 41)) + 1, false)");
        },
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
