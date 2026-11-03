import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
/** The directory must live on persistent storage in production. Claims never expire. */
export function createDispatchStore({ directory }) {
 let initialized;
 const ready = () => initialized ??= mkdir(directory, { recursive: true, mode: 0o700 });
 function paths(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > 512) throw new Error('Invalid dispatch key');
  const name = createHash('sha256').update(key).digest('hex');
  return { claim: join(directory, `${name}.claim.json`), receipt: join(directory, `${name}.receipt.json`) };
 }
 async function syncDirectory() { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
 async function write(handle, value) { try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); } }
 async function read(key) {
  await ready(); const path = paths(key); let claim;
  try { claim = JSON.parse(await readFile(path.claim, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return { owner: null, result: null }; }
  let result = null;
  try { const receipt = JSON.parse(await readFile(path.receipt, 'utf8')); if (receipt.owner === claim.owner) result = receipt.result; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return { owner: claim.owner, result };
 }
 return {
  read,
  async claim(key) {
   await ready(); const path = paths(key), owner = randomUUID(); let handle;
   try { handle = await open(path.claim, 'wx', 0o600); }
   catch (error) { if (error.code === 'EEXIST') return { claimed: false, record: await read(key) }; throw error; }
   await write(handle, { owner, claimedAt: new Date().toISOString() });
   await syncDirectory();
   return { claimed: true, owner };
  },
  async save(key, owner, result) {
   await ready(); const record = await read(key);
   if (!owner || record?.owner !== owner) throw new Error('Dispatch claim ownership mismatch');
   const path = paths(key), temporary = `${path.receipt}.${randomUUID()}.tmp`;
   await write(await open(temporary, 'wx', 0o600), { owner, result, updatedAt: new Date().toISOString() });
   await rename(temporary, path.receipt); await syncDirectory();
  },
 };
}
