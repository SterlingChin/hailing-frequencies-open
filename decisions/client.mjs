import { buildDecisionRequest, validAnswerSet } from './questions.mjs';

/**
 * Minimal POST /decisions client. Constructing it sends nothing. Each decide()
 * is one request with no retry; a timeout or 5xx is reported, never replayed.
 * Response bodies are validated for shape and never logged: they can echo the
 * context bundle. With no API key the client is disabled and returns a
 * non-throwing "unavailable" so the call can continue without a decision.
 */
export function createDecisionsClient({ apiKey = null, fetch = globalThis.fetch, baseUrl = 'https://api.openai.com/v1', timeoutMs = 8000, model } = {}) {
  const enabled = typeof apiKey === 'string' && apiKey.trim().length > 0;
  return {
    enabled,
    async decide({ input, safetyIdentifier = null, questions }) {
      const request = buildDecisionRequest({ input, safetyIdentifier, questions, ...(model ? { model } : {}) });
      if (!enabled) return { ok: false, error: { code: 'decisions_unavailable' }, request };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(`${baseUrl}/decisions`, { method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request) });
        if (response.status !== 200) return { ok: false, error: { code: 'decisions_http', status: response.status, retryAfter: response.headers?.get?.('retry-after') ?? null } };
        let body;
        try { body = await response.json(); }
        catch { return { ok: false, error: { code: controller.signal.aborted ? 'decisions_timeout' : 'decisions_invalid_body' } }; }
        if (controller.signal.aborted) return { ok: false, error: { code: 'decisions_timeout' } };
        if (!body || !validAnswerSet(body.answers, request.questions)) return { ok: false, error: { code: 'decisions_invalid_body' } };
        return { ok: true, model: typeof body.model === 'string' ? body.model : null, answers: body.answers,
          usage: body.usage && typeof body.usage === 'object' ? { input_tokens: body.usage.input_tokens ?? null, total_tokens: body.usage.total_tokens ?? null } : null };
      } catch (error) {
        return { ok: false, error: { code: controller.signal.aborted || error?.name === 'AbortError' ? 'decisions_timeout' : 'decisions_network' } };
      } finally { clearTimeout(timer); }
    },
  };
}
