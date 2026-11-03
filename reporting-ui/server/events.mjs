/** Coalesce snapshots while a client is slow; retain only the latest pending state. */
export function createSnapshotWriter(res) {
 let blocked = false, pending = null, closed = false;
 function write(message) {
  if (closed || res.writableEnded || res.destroyed) return;
  if (blocked) { pending = message; return; }
  blocked = !res.write(message);
 }
 res.on('drain', () => { blocked = false; const latest = pending; pending = null; if (latest !== null) write(latest); });
 res.on('close', () => { closed = true; pending = null; });
 return { write, heartbeat() { if (!blocked) write(': heartbeat\n\n'); } };
}
