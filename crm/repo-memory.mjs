import { columns, validateColumns, matches, caseId } from './repo-shared.mjs';

export class MemoryRepository {
  #state = { tables: Object.fromEntries(Object.keys(columns).map(t => [t, []])), nextCaseNumber: 42 };
  #tail = Promise.resolve();
  async transaction(work) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    const draft = structuredClone(this.#state);
    const tx = {
      async find(table, where = {}) {
        validateColumns(table, where);
        return structuredClone(draft.tables[table].filter(row => matches(row, where)));
      },
      async insert(table, row) {
        validateColumns(table, row);
        const uniqueKeys = ['id', ...(table === 'crew_members' ? ['auth_code_hash'] : []),
          ...(['interactions', 'outbound_messages'].includes(table) ? ['provider_sid'] : []),
          ...(table === 'outbound_messages' ? ['idempotency_key'] : [])];
        if (uniqueKeys.some(key => row[key] != null && draft.tables[table].some(r => r[key] === row[key]))) throw new Error('Duplicate record');
        draft.tables[table].push(structuredClone(row));
        return structuredClone(row);
      },
      async update(table, id, patch) {
        validateColumns(table, patch);
        const row = draft.tables[table].find(row => row.id === id);
        if (!row) return null;
        Object.assign(row, structuredClone(patch));
        return structuredClone(row);
      },
      async remove(table, where) {
        validateColumns(table, where);
        draft.tables[table] = draft.tables[table].filter(row => !matches(row, where));
      },
      async nextCaseId() { return caseId(draft.nextCaseNumber++); },
      async resetCaseSequence() {
        draft.nextCaseNumber = Math.max(41, ...draft.tables.cases.map(c => Number(c.id.slice(3)))) + 1;
      },
    };
    try {
      const result = await work(tx);
      this.#state = draft;
      return result;
    } finally { release(); }
  }
  async close() {}
}
