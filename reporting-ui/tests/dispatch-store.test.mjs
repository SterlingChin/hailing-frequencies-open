import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchStore } from '../server/dispatch-store.mjs';
test('exclusive durable claims and receipts survive new store instances', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'hf-claims-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const a = createDispatchStore({ directory }), b = createDispatchStore({ directory });
 const claims = await Promise.all([a.claim('key'), b.claim('key')]);
 assert.equal(claims.filter(item => item.claimed).length, 1);
 const winner = claims.find(item => item.claimed);
 await a.save('key', winner.owner, { status: 'dispatched', dispatchId: 'dispatch-1' });
 const fresh = createDispatchStore({ directory });
 assert.deepEqual((await fresh.read('key')).result, { status: 'dispatched', dispatchId: 'dispatch-1' });
 assert.equal((await fresh.claim('key')).claimed, false);
 await assert.rejects(fresh.save('key', 'wrong-owner', { status: 'failed' }));
});
test('claimed calls without receipts remain uncertain after restart and are never reclaimed', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'hf-claims-')); t.after(() => rm(directory, { recursive: true, force: true }));
 await createDispatchStore({ directory }).claim('key');
 const fresh = createDispatchStore({ directory });
 assert.equal((await fresh.claim('key')).claimed, false);
 assert.equal((await fresh.read('key')).result, null);
 assert.equal(await fresh.read('absent'), null);
});
