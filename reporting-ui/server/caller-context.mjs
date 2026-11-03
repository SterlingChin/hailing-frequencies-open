/** Server-only caller context transport. No credentials or session tokens are
 * exposed to the browser or included in agent tool results. */
export function createCallerContext({ env = process.env, fetchImpl = fetch, onDiagnostic = event => console.error(JSON.stringify(event)) } = {}) {
  const base = env.CONTEXT_API_BASE_URL || 'https://hailing-frequencies-app-production.up.railway.app';
  const token = env.CONTEXT_API_TOKEN?.trim();
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Caller context requires a clean HTTPS base URL.');
  const configured = Boolean(token && token.length >= 32);
  async function request(operation, body, expectedStatus) {
    if (!configured) return { ok: false, error: 'identity_service_not_configured' };
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, '')}/api/v1/caller-context/${operation}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      const data = await response.json().catch(() => null);
      if (response.status !== expectedStatus) {
        const allowed = new Set(['phrase_not_accepted', 'attempt_limit', 'invalid_session', 'authorization_required', 'profile_already_loaded']);
        const error = allowed.has(data?.error) ? data.error
          : response.status === 400 || response.status === 415 ? 'identity_request_rejected'
          : response.status === 401 || response.status === 403 ? 'identity_service_credentials_rejected'
          : response.status === 404 ? 'identity_endpoint_not_found'
          : response.status === 429 ? 'identity_service_rate_limited' : 'identity_service_unavailable';
        onDiagnostic({ event: 'identity_request_failed', operation, status: response.status, code: error });
        return { ok: false, error };
      }
      return { ok: true, data };
    } catch { return { ok: false, error: 'identity_service_unavailable' }; }
  }
  return {
    configured,
    async start() {
      // Browser callers have no phone hint: omit caller_phone entirely.
      const result = await request('start', {}, 201);
      if (!result.ok) return result;
      const { session_token, expires_at, state } = result.data ?? {};
      if (typeof session_token !== 'string' || !session_token || typeof expires_at !== 'string' || !Number.isFinite(Date.parse(expires_at)) || state !== 'authorization_required') return { ok: false, error: 'identity_service_invalid_response' };
      return { ok: true, sessionToken: session_token, expiresAt: expires_at };
    },
    async authorize(sessionToken, { name, authorization }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof authorization !== 'string' || !authorization.trim() || authorization.length > 250) return { ok: false, error: 'name_and_phrase_required' };
      const result = await request('authorize', { session_token: sessionToken, name, authorization }, 200);
      if (!result.ok) return result;
      const profile = result.data?.profile;
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || typeof profile.display_name !== 'string' || !profile.display_name.trim()) return { ok: false, error: 'identity_service_invalid_response' };
      const crewMemberId = result.data?.crew_member_id ?? profile.crew_member_id;
      return { ok: true, profile, ...(typeof crewMemberId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(crewMemberId) ? { crewMemberId } : {}) };
    },
    async end(sessionToken) {
      return request('end', { session_token: sessionToken }, 200);
    },
  };
}
