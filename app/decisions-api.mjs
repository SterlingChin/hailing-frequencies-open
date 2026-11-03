import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_REPORTER_CONTEXT, CREW_ID } from '../crm/reporter-context.mjs';
import { CRMError } from '../crm/service.mjs';
import { reportingAction } from '../decisions/reporting-action.mjs';

const digest = value => createHash('sha256').update(value).digest();
const matches = (value, expected) => typeof value === 'string' && value.length <= 512
  && timingSafeEqual(digest(value), digest(expected));
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const failure = code => ({ ok: false, error: { code } });

// The reporting backend authenticates the caller and supplies their crew ID.
// The service bearer token remains mandatory. Legacy signed sessions still work.
export const MAX_DECISION_BODY_BYTES = 512000;
export function createDecisionsApi({ decisionStep = null, token = null, now = Date.now } = {}) {
  if (token !== null && (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token))) throw new Error('Invalid REPORTING_API_TOKEN');
  function session(value) {
    if (typeof value !== 'string' || value.length > 160) return null;
    const [id, expires, signature, extra] = value.split('.');
    if (extra !== undefined || !UUID.test(id ?? '') || !/^\d{13}$/.test(expires ?? '')
      || !/^[a-f0-9]{64}$/.test(signature ?? '') || Number(expires) <= now()) return null;
    const expected = createHmac('sha256', token).update(`reporting-session:v1:${id}.${expires}`).digest('hex');
    return matches(signature, expected) ? id : null;
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
    return true;
  }
  return async function handle(req, res) {
    if (req.url !== '/api/decisions') return false;
    if (!token) return json(res, 404, failure('not_found'));
    if (!matches(req.headers.authorization, `Bearer ${token}`)) return json(res, 401, failure('unauthorized'));
    if (req.headers.origin !== undefined) return json(res, 403, failure('server_to_server_only'));
    if (req.method !== 'POST') return json(res, 405, failure('method_not_allowed'));
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, failure('json_required'));
    if (!decisionStep) return json(res, 503, failure('memory_unavailable'));
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > MAX_DECISION_BODY_BYTES) return json(res, 413, failure('request_too_large'));
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return json(res, 400, failure('invalid_json')); }
    if (!body || Array.isArray(body) || Object.keys(body).length !== 2) return json(res, 400, failure('invalid_arguments'));
    const reporter = Object.hasOwn(body, 'crew_member_id');
    let interactionId;
    if (reporter) {
      if (typeof body.crew_member_id !== 'string' || !CREW_ID.test(body.crew_member_id)
        || typeof body.context !== 'string' || !body.context.trim() || body.context.length > MAX_REPORTER_CONTEXT
        || body.context.includes('\0') || !body.context.isWellFormed()) return json(res, 400, failure('invalid_arguments'));
    } else {
      if (!Object.hasOwn(body, 'session_token') || typeof body.request !== 'string' || !body.request.trim()
        || body.request.length > 300) return json(res, 400, failure('invalid_arguments'));
      interactionId = session(body.session_token);
      if (!interactionId) return json(res, 401, failure('invalid_or_expired_session'));
    }
    let decision;
    try {
      decision = reporter
        ? await decisionStep.evaluateReporter({ crewMemberId: body.crew_member_id.toLowerCase(), blob: body.context })
        : await decisionStep.evaluate({ interactionId, request: body.request, channel: 'voice' });
    } catch (error) {
      const code = error instanceof CRMError ? error.code : 'decision_unavailable';
      if (code === 'ship_not_found') return json(res, 404, { ok: false, error: {
        code: 'crew_member_not_found', reason: 'ship_not_found', message: 'USS Nebraska does not exist in this demo.',
      } });
      return json(res, code === 'crew_member_not_found' ? 404 : code === 'invalid_arguments' ? 400 : 503, failure(code));
    }
    if (!decision.identified) return json(res, decision.reason === 'profile_required' ? 403 : 409, failure(decision.reason));
    return json(res, 200, {
      ok: true, fictional: true, context_id: decision.contextId ?? null, issue: decision.issue ?? null, outcome: decision.outcome, reason: decision.reason,
      route: decision.route ?? null, urgency: decision.urgencyLabel ?? null,
      answers: {
        route: { value: decision.route ?? null, confidence: decision.routeConfidence ?? null },
        issue: { value: decision.issue ?? null, confidence: decision.issueConfidence ?? null },
        resolvable_now: decision.resolvableNow ?? null,
        needs_more_details: decision.needsMoreDetails ?? null,
        urgency: { score: decision.urgency ?? null, label: decision.urgencyLabel ?? null },
      },
      state: decision.outcome === 'queue' ? 'queued' : decision.outcome,
      task_id: decision.task?.id ?? null, reused: decision.reused ?? false,
      callback_owner: decision.task?.specialist ?? null,
      callback_status: callbackStatus(decision.task),
      solution: decision.solution ?? null,
      ...reportingAction(decision),
    });
  };
}

export function callbackStatus(task) {
  if (!task) return null;
  if (task.reply_channel !== 'voice' || !task.reply_consent_at) return 'not_requested';
  if (task.reply_outcome === 'placed') return 'call_placed';
  if (['failed', 'unavailable'].includes(task.reply_outcome)) return task.reply_outcome;
  if (task.reply_claimed_at) return 'placement_unknown';
  return 'callback_requested';
}
