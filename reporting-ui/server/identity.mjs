/** Owns one context session per voice channel, including late-start cleanup. */
export function createIdentity({ client, state, notify = () => {} }) {
  let starting, token, expiresAt, ended = false, ending;
  function start() {
    if (!starting) starting = (async () => {
      state.identityStatus = 'connecting'; notify();
      const result = await client.start();
      if (result.ok) {
        token = result.sessionToken; expiresAt = Date.parse(result.expiresAt);
        if (ended) await endToken();
        else { state.identityStatus = 'authorization_required'; }
      } else if (!ended) state.identityStatus = result.error;
      notify(); return result;
    })();
    return starting;
  }
  async function endToken() {
    if (!token) return;
    if (!ending) ending = client.end(token).then(result => {
      if (!result.ok) console.error(JSON.stringify({ event: 'identity_end_failed', code: result.error }));
    }).catch(() => console.error(JSON.stringify({ event: 'identity_end_failed', code: 'transport_error' })));
    await ending;
  }
  return {
    start,
    valid() { if (ended || (Number.isFinite(expiresAt) && Date.now() >= expiresAt)) { state.authorized = false; return false; } return state.authorized; },
    async authorize(args) {
      if (ended) return { ok: false, error: 'channel_ended' };
      if (!starting) return { ok: false, error: 'identity_not_ready' };
      const started = await starting;
      if (ended) return { ok: false, error: 'channel_ended' };
      if (!started.ok) return { ok: false, error: started.error };
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) { state.authorized = false; state.identityStatus = 'invalid_session'; return { ok: false, error: 'invalid_session' }; }
      if (state.authorized) return { ok: true, profile: state.profile };
      const result = await client.authorize(token, args);
      if (ended) return { ok: false, error: 'channel_ended' };
      if (result.ok) { state.authorized = true; state.profile = result.profile; state.crewMemberId = result.crewMemberId; state.identityStatus = 'profile_loaded'; }
      else { state.identityStatus = result.error; if (result.error === 'phrase_not_accepted') state.attempts++; }
      notify(); return result;
    },
    end() { ended = true; return starting ? starting.then(endToken) : Promise.resolve(); },
  };
}
