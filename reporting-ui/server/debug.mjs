const PRIVATE_KEY = /^(authorization(?:_phrase)?|spoken_phrase|spoken_code|session_?token|access_?token|refresh_?token|api_?key|client_secret|csrf|sdp|authorization_hash|password)$/i;
const MAX_BODY = 1024 * 1024, MAX_HISTORY = 2 * 1024 * 1024;
/** Per-conversation HTTP response capture. Never logs headers or request bodies. */
export function createDebugFetch({ state, fetchImpl = fetch, notify = () => {}, secrets = [] }) {
 const hidden = new Set(secrets.filter(value => typeof value === 'string' && value));
 function collect(value) {
  if (typeof value === 'string') { try { if (/^\s*[\[{]/.test(value)) collect(JSON.parse(value)); } catch {} return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) { if (PRIVATE_KEY.test(key) && key !== 'sdp' && typeof item === 'string' && item) hidden.add(item); else collect(item); }
 }
 function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, PRIVATE_KEY.test(key) ? '[REDACTED]' : scrub(item)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of hidden) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/("(?:authorization(?:_phrase)?|spoken_phrase|spoken_code|session_?token|access_?token|refresh_?token|api_?key|client_secret|csrf|sdp|password)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
  text = text.replace(/Bearer\s+[\w.-]+/gi, 'Bearer [REDACTED]');
  try { if (/^\s*[\[{]/.test(text)) return JSON.stringify(scrub(JSON.parse(text))); } catch {}
  return text;
 }
 function remember(entry) {
  const history = state.debugResponses ??= [];
  history.push(entry);
  while (history.length > 20 || history.reduce((total, item) => total + item.body.length, 0) > MAX_HISTORY) { history.shift(); state.debugDropped = (state.debugDropped || 0) + 1; }
  notify();
 }
 return async (url, options = {}) => {
  const target = new URL(url), started = Date.now();
  let operation;
  try {
   const request = JSON.parse(options.body);
   operation = request.method;
   collect(request);
  } catch {}
  const meta = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), endpoint: `${target.origin}${target.pathname}`, method: options.method || 'GET', ...(operation ? { operation } : {}) };
  let response;
  try { response = await fetchImpl(url, options); }
  catch (error) { remember({ ...meta, status: null, durationMs: Date.now() - started, body: JSON.stringify({ error: 'transport_error', type: error.name }) }); throw error; }
  try {
   const reader = response.clone().body?.getReader(), chunks = []; let size = 0, truncated = false;
   if (reader) while (true) { const { done, value } = await reader.read(); if (done) break; const remaining = MAX_BODY - size; chunks.push(value.subarray(0, remaining)); size += Math.min(remaining, value.length); if (value.length > remaining || size >= MAX_BODY) { truncated = true; void reader.cancel(); break; } }
   const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
   const raw = new TextDecoder().decode(bytes); let body;
   try { const parsed = JSON.parse(raw); collect(parsed); body = JSON.stringify(scrub(parsed), null, 2); }
   catch { for (const line of raw.split(/\r?\n/)) { try { collect(JSON.parse(line.replace(/^data:\s*/, ''))); } catch {} } body = scrub(raw); }
   remember({ ...meta, status: response.status, durationMs: Date.now() - started, body, truncated });
  } catch { remember({ ...meta, status: response.status, durationMs: Date.now() - started, body: '[Response body could not be captured]' }); }
  return response;
 };
}
