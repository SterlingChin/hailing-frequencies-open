// Compatibility name for the CLI callers. Configuration comes only from the
// process environment; opt into Node's --env-file flag for local development.
export async function readLocalEnv() {
  return { ...process.env };
}

// Seed/reset and integration tests are local-only. Never infer a remote target.
export function requireLocalDatabase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A local database URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash) {
    throw new Error('A loopback database URL without query overrides is required');
  }
  return value;
}

/**
 * Explicit remote opt-in for demo seeds: the caller must name the exact host
 * they intend to write to. Query overrides are still refused. This is for
 * fictional demo rows only; it does not loosen the local-only test guard.
 */
export function requireConfirmedDatabase(value, confirmedHost) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A database URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) throw new Error('A postgres URL without query overrides is required');
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return value;
  if (typeof confirmedHost !== 'string' || !confirmedHost.trim() || confirmedHost.trim().toLowerCase() !== url.hostname.toLowerCase()) {
    throw new Error('Remote database refused: pass --remote-host with the exact hostname to confirm');
  }
  return value;
}
