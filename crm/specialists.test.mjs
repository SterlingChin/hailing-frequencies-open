import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from './repo-memory.mjs';
import { createCRMService } from './service.mjs';
import { createCallTools } from './tools.mjs';
import { DEMO, seedDemo } from './seed.mjs';
import { lookupRepair } from '../voice/config.mjs';
import { lookupParts } from '../specialists/catalog.mjs';
import { setImmediate as tick } from 'node:timers/promises';

async function setup(t, lookup = lookupParts) {
  const repo = new MemoryRepository(); await seedDemo(repo, { scenario: 'fresh', phone: '+12025550123' });
  const service = createCRMService(repo), context = { callSid: 'specialists-fixture' };
  const tools = createCallTools({ service, context, lookupRepair, lookupParts: lookup });
  t.after(() => tools.end());
  await tools.handle('load_crew_profile', { spoken_code: DEMO.authCode });
  await tools.handle('open_case', { equipment_id: DEMO.equipmentId, symptom: 'cold coffee' });
  return { tools, repo, context };
}
test('Engineering and Logistics record separate tasks on the same case; availability is not an order', async t => {
  const f = await setup(t);
  assert.equal((await f.tools.handle('lookup_repair', { equipment_model: 'RPL-2400', symptom: 'cold' })).ok, true);
  const result = await f.tools.handle('check_parts', {});
  assert.equal(result.status, 'available'); assert.match(result.summary, /Nothing is reserved or ordered/);
  const tasks = await f.repo.transaction(tx => tx.find('specialist_tasks'));
  assert.deepEqual(tasks.map(t => t.specialist), ['engineering', 'logistics']);
  assert.ok(tasks.every(t => t.case_id === f.context.caseId && t.status === 'result_ready'));
  assert.equal((await f.repo.transaction(tx => tx.find('part_orders'))).length, 0);
  assert.equal(lookupParts({ equipment_model: 'RPL-7' }).ok, true);
  assert.equal(lookupParts({ equipment_model: 'unknown' }).ok, false);
});
test('late Logistics result is obsolete after a symptom correction; selectors cannot escape the current case', async t => {
  let finish;
  const f = await setup(t, args => new Promise(resolve => { finish = () => resolve(lookupParts(args)); }));
  assert.equal((await f.tools.handle('check_parts', { case_id: 'HF-999' })).error.code, 'invalid_arguments');
  const pending = f.tools.handle('check_parts', {});
  while (!finish) await tick();
  await f.tools.handle('update_symptom', { symptom: 'tea cold too' }); finish();
  assert.equal((await pending).error.code, 'obsolete_result');
  const [task] = await f.repo.transaction(tx => tx.find('specialist_tasks'));
  assert.equal(task.status, 'obsolete'); assert.ok(task.result.summary);
});
test('failed Logistics check records failure and returns no successful finding', async t => {
  const f = await setup(t, () => { throw new Error('private exception'); });
  const result = await f.tools.handle('check_parts', {});
  assert.equal(result.error.code, 'parts_lookup_failed'); assert.equal(result.summary, undefined);
  assert.equal((await f.repo.transaction(tx => tx.find('specialist_tasks')))[0].status, 'failed');
});
