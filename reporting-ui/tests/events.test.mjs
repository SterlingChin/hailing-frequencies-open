import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSnapshotWriter } from '../server/events.mjs';
test('slow event streams coalesce snapshots and flush only the latest on drain', () => {
 const res = new EventEmitter(), writes = []; let accepted = false;
 res.write = message => { writes.push(message); return accepted; };
 const writer = createSnapshotWriter(res);
 writer.write('first'); writer.write('second'); writer.write('latest'); writer.heartbeat();
 assert.deepEqual(writes, ['first']);
 accepted = true; res.emit('drain'); assert.deepEqual(writes, ['first', 'latest']);
 writer.write('new'); assert.deepEqual(writes, ['first', 'latest', 'new']);
 res.emit('close'); writer.write('after close'); assert.equal(writes.length, 3);
});
