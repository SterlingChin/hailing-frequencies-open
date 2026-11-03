import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CRMError } from '../crm/service.mjs';
import { CRM_TOOLS } from '../crm/tools.mjs';

const PATH = '/api/reporting';
const SESSION_MS = 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const NAMES = new Set(['load_crew_profile', 'get_crm_context', 'resume_case', 'review_case', 'open_case',
  'update_symptom', 'get_case_brief', 'record_repair_outcome', 'close_case']);
export const REPORTING_TOOLS = CRM_TOOLS.filter(tool => NAMES.has(tool.name));
const INSTRUCTIONS = 'Ask for the caller’s authorization phrase and call load_crew_profile before discussing CRM records. '
  + 'A loaded demo profile does not establish that the caller belongs to a recognized ship. If Decisions returns crew_member_not_found with reason ship_not_found, tell the caller USS Nebraska does not exist in this demo and their claimed crew membership cannot be recognized. Do not claim the report was accepted or routed. '
  + 'Before the profile loads, speak English. After it loads, use profile.preferred_language for every spoken reply: English for english, Klingon for klingon. Keep tool names, IDs and stored CRM values unchanged. '
  + 'Use only returned facts. Ask which existing case the caller means and obtain confirmation before resume_case or review_case. '
  + 'Review closed cases without reopening them; use open_case for a new issue. Record corrections with update_symptom. '
  + 'Refresh get_crm_context for stored answers and task status. A specialist finding is not a confirmed fix. '
  + 'Only record a repair outcome or close a case at the caller’s explicit request. These tools store CRM records; they do not dispatch specialists, place calls or send texts.';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const failure = code => ({ ok: false, error: { code } });
const digest = value => createHash('sha256').update(value).digest();
const matchesSecret = (value, expected) => typeof value === 'string' && value.length <= 512 && timingSafeEqual(digest(value), digest(expected));
const statusFor = code => ({ invalid_arguments: 400, unsupported_tool: 400, profile_required: 403,
  profile_not_found: 403, auth_attempt_limit: 429, not_found: 404, case_not_available: 404,
  equipment_not_available: 404, memory_unavailable: 503 }[code] ?? 409);

function validArguments(name, args) {
  const schema = REPORTING_TOOLS.find(tool => tool.name === name)?.parameters;
  if (!schema || !exact(args, Object.keys(schema.properties))) return false;
  return Object.entries(schema.properties).every(([key, prop]) => typeof args[key] === prop.type
    && (!prop.enum || prop.enum.includes(args[key]))
    && (prop.type !== 'string' || (args[key].trim().length > 0 && args[key].length <= (key === 'spoken_code' ? 250 : 300))))
    && (args.case_id === undefined || /^HF-\d{3,12}$/.test(args.case_id))
    && (args.equipment_id === undefined || UUID.test(args.equipment_id));
}

/** Server-to-server CRM adapter. No provider transports, phone input, or arbitrary record selectors. */
export function createReportingApi({ service = null, token = null, now = () => Date.now() } = {}) {
  if (token !== null && (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token))) {
    throw new Error('REPORTING_API_TOKEN must contain 32–256 non-whitespace ASCII characters.');
  }
  const sign = text => createHmac('sha256', token).update(`reporting-session:v1:${text}`).digest('hex');
  function sessionToken(interaction) {
    const expires = Date.parse(interaction.started_at) + SESSION_MS;
    const payload = `${interaction.id}.${expires}`;
    return { session_token: `${payload}.${sign(payload)}`, expires_at: new Date(expires).toISOString() };
  }
  function interactionId(value, allowExpired = false) {
    if (typeof value !== 'string' || value.length > 160) return null;
    const [id, expires, signature, extra] = value.split('.');
    if (extra !== undefined || !UUID.test(id ?? '') || !/^\d{13}$/.test(expires ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '')) return null;
    if (!matchesSecret(signature, sign(`${id}.${expires}`)) || (!allowExpired && Number(expires) <= now())) return null;
    return id;
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
    return true;
  }
  async function invoke(id, name, args) {
    if (name === 'load_crew_profile') {
      const loaded = await service.loadProfileByAuthCode({ interactionId: id, spokenCode: args.spoken_code });
      if (!loaded.ok) return loaded;
      return { ok: true, state: 'demo_profile_loaded', preferred_language: loaded.profile.preferred_language, profile: loaded.profile,
        crm_context: await service.getInteractionContext({ interactionId: id }) };
    }
    if (name === 'get_case_brief') return { ok: true, brief: await service.getInteractionBrief(id) };
    if (name === 'resume_case' || name === 'review_case') {
      await service.attachInteraction({ interactionId: id, caseId: args.case_id, callerConfirmed: args.caller_confirmed, reviewOnly: name === 'review_case' });
    } else if (name === 'open_case') {
      await service.openCase({ interactionId: id, equipmentId: args.equipment_id, symptom: args.symptom });
    } else if (name === 'update_symptom') {
      await service.updateSymptom({ interactionId: id, symptom: args.symptom });
    } else if (name === 'record_repair_outcome') {
      await service.recordDiagnosisOutcome({ interactionId: id, outcome: args.outcome, callerConfirmed: args.caller_confirmed });
    } else if (name === 'close_case') {
      await service.closeCase({ interactionId: id, callerConfirmed: args.caller_confirmed });
    }
    return { ok: true, crm_context: await service.getInteractionContext({ interactionId: id }) };
  }
  return async function handle(req, res) {
    if (req.url !== PATH) return false;
    if (!token) return json(res, 404, failure('not_found'));
    if (!matchesSecret(req.headers.authorization, `Bearer ${token}`)) return json(res, 401, failure('unauthorized'));
    if (req.headers.origin !== undefined) return json(res, 403, failure('server_to_server_only'));
    if (req.method !== 'POST') return json(res, 405, failure('method_not_allowed'));
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, failure('json_required'));
    if (!service) return json(res, 503, failure('memory_unavailable'));
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 16384) return json(res, 413, failure('request_too_large'));
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return json(res, 400, failure('invalid_json')); }
    if (!object(body)) return json(res, 400, failure('invalid_arguments'));
    try {
      if (body.action === 'start') {
        if (!exact(body, ['action', 'channel_id']) || typeof body.channel_id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(body.channel_id)) {
          return json(res, 400, failure('invalid_arguments'));
        }
        // The same server-generated channel ID retains the database attempt limit across HTTP retries/restarts.
        const i = await service.beginInteraction({ providerSid: `reporting:${body.channel_id}` });
        if (i.ended_at) return json(res, 409, failure('interaction_ended'));
        if (Date.parse(i.started_at) + SESSION_MS <= now()) return json(res, 409, failure('session_expired'));
        return json(res, 200, { ok: true, ...sessionToken(i), tools: REPORTING_TOOLS, instructions: INSTRUCTIONS });
      }
      if (!['tool', 'end'].includes(body.action) || !exact(body, body.action === 'tool'
        ? ['action', 'session_token', 'name', 'arguments'] : ['action', 'session_token'])) return json(res, 400, failure('invalid_arguments'));
      const id = interactionId(body.session_token, body.action === 'end');
      if (!id) return json(res, 401, failure('invalid_or_expired_session'));
      if (body.action === 'end') {
        await service.endInteraction(id);
        return json(res, 200, { ok: true, state: 'ended' });
      }
      if (!NAMES.has(body.name)) return json(res, 400, failure('unsupported_tool'));
      if (!validArguments(body.name, body.arguments)) return json(res, 400, failure('invalid_arguments'));
      const result = await invoke(id, body.name, body.arguments);
      return json(res, result.ok ? 200 : statusFor(result.error.code), result);
    } catch (error) {
      const code = error instanceof CRMError ? error.code : 'memory_unavailable';
      return json(res, statusFor(code), failure(code));
    }
  };
}
