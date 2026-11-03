import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const BASE = '/api/v1/caller-context';
const ROUTES = new Set([`${BASE}/start`, `${BASE}/authorize`, `${BASE}/context`, `${BASE}/end`]);
const E164 = /^\+[1-9]\d{1,14}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const SESSION_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 64;

class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(header, secret) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req, allowed) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new RequestError(415, 'json_required');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new RequestError(413, 'body_too_large');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw new RequestError(400, 'invalid_body');
  }
  return body;
}

/** Private, single-process sessions. Losing a session on restart fails closed. */
export function createCallerContextApi({ service, token, now = () => Date.now() }) {
  const sessions = new Map();
  const counters = { starts: { until: 0, count: 0 }, phrases: { until: 0, count: 0 } };
  const digest = value => createHash('sha256').update(value).digest('hex');
  const rateLimit = (kind, max) => {
    const counter = counters[kind];
    if (now() >= counter.until) { counter.until = now() + SESSION_MS; counter.count = 0; }
    counter.count += 1;
    if (counter.count > max) throw new RequestError(429, 'rate_limited');
  };
  async function endSession(key, entry) {
    if (sessions.get(key) !== entry) return;
    sessions.delete(key);
    clearTimeout(entry.timer);
    await service.endInteraction(entry.interactionId);
  }
  function session(value) {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new RequestError(401, 'invalid_session');
    const key = digest(value), entry = sessions.get(key);
    if (!entry) throw new RequestError(401, 'invalid_session');
    if (entry.expiresAt <= now()) {
      void endSession(key, entry).catch(() => {});
      throw new RequestError(401, 'invalid_session');
    }
    return { key, entry };
  }
  return {
    async handle(req, res) {
      if (!ROUTES.has(req.url)) return false;
      if (!token) { reply(res, 404, { error: 'not_found' }); return true; }
      if (req.method !== 'POST') { reply(res, 405, { error: 'method_not_allowed' }); return true; }
      if (!authorized(req.headers.authorization, token)) { reply(res, 401, { error: 'unauthorized' }); return true; }
      if (!service) { reply(res, 503, { error: 'context_unavailable' }); return true; }
      try {
        if (req.url === `${BASE}/start`) {
          const body = await readBody(req, ['caller_phone']);
          if (body.caller_phone != null && (typeof body.caller_phone !== 'string' || !E164.test(body.caller_phone))) {
            throw new RequestError(400, 'invalid_caller_phone');
          }
          rateLimit('starts', 100);
          if (sessions.size >= MAX_SESSIONS) throw new RequestError(429, 'too_many_sessions');
          const interaction = await service.beginInteraction({ providerSid: `context-api:${randomUUID()}` });
          let candidateIds;
          try { candidateIds = body.caller_phone ? await service.findCandidatesByPhone(body.caller_phone) : []; }
          catch (error) { await service.endInteraction(interaction.id).catch(() => {}); throw error; }
          const sessionToken = randomBytes(32).toString('hex'), key = digest(sessionToken);
          const entry = { interactionId: interaction.id, candidateIds, loaded: false, expiresAt: now() + SESSION_MS };
          entry.timer = setTimeout(() => { void endSession(key, entry).catch(() => {}); }, SESSION_MS);
          entry.timer.unref?.();
          sessions.set(key, entry);
          reply(res, 201, { session_token: sessionToken, expires_at: new Date(entry.expiresAt).toISOString(), state: 'authorization_required' });
          return true;
        }
        if (req.url === `${BASE}/authorize`) {
          const body = await readBody(req, ['session_token', 'name', 'authorization']);
          const { entry } = session(body.session_token);
          if (entry.loaded) throw new RequestError(409, 'profile_already_loaded');
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) {
            throw new RequestError(400, 'invalid_name');
          }
          if (typeof body.authorization !== 'string' || !body.authorization.trim() || body.authorization.length > 250) {
            throw new RequestError(400, 'invalid_phrase');
          }
          rateLimit('phrases', 30);
          const result = await service.loadProfileByAuthCode({ spokenCode: body.authorization, name: body.name,
            candidateIds: entry.candidateIds, interactionId: entry.interactionId, demoOnly: true });
          if (!result.ok) throw new RequestError(result.error.code === 'auth_attempt_limit' ? 429 : 401,
            result.error.code === 'auth_attempt_limit' ? 'attempt_limit' : 'phrase_not_accepted');
          entry.loaded = true;
          entry.crewMemberId = result.crewId;
          reply(res, 200, { state: 'demo_profile_loaded', assurance: 'fictional_phrase_only', crew_member_id: entry.crewMemberId, profile: result.profile });
          return true;
        }
        const body = await readBody(req, ['session_token']);
        const { key, entry } = session(body.session_token);
        if (req.url === `${BASE}/context`) {
          if (!entry.loaded) throw new RequestError(403, 'authorization_required');
          const profile = await service.getInteractionProfile(entry.interactionId);
          reply(res, 200, { state: 'demo_profile_loaded', assurance: 'fictional_phrase_only', crew_member_id: entry.crewMemberId, profile });
        } else {
          await endSession(key, entry);
          reply(res, 200, { state: 'ended' });
        }
      } catch (error) {
        reply(res, error instanceof RequestError ? error.status : 503,
          { error: error instanceof RequestError ? error.code : 'context_unavailable' });
      }
      return true;
    },
    async close() {
      await Promise.allSettled([...sessions].map(([key, entry]) => endSession(key, entry)));
    },
  };
}
