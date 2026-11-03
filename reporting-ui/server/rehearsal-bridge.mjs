import { randomUUID } from 'node:crypto';
import { PHRASE } from './reporting.mjs';

const ROUTE_TOOL = { type: 'function', name: 'route_request', strict: true,
  description: 'Ask the four-question Decisions API to use a stored solution, request details, or queue the selected case with IT or Maintenance. Use the caller’s own words.',
  parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false } };

export function rehearsalConfig(env = process.env) {
  const enabled = env.REHEARSAL_ENABLED === 'true';
  const url = env.HF_BACKEND_URL?.replace(/\/$/, '') ?? null;
  if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(env.HOST ?? '127.0.0.1')) {
    throw new Error('The real-data rehearsal is available on local loopback only.');
  }
  if (enabled && (!url || !/^https:\/\//.test(url) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(url))) {
    throw new Error('HF_BACKEND_URL must be HTTPS or local loopback.');
  }
  if (enabled && !/^[\x21-\x7e]{32,256}$/.test(env.REPORTING_API_TOKEN ?? '')) {
    throw new Error('REPORTING_API_TOKEN must contain 32–256 non-whitespace ASCII characters.');
  }
  return { enabled, url, token: env.REPORTING_API_TOKEN ?? null };
}

export function createRehearsalBridge({ config = rehearsalConfig(), fetchImpl = fetch } = {}) {
  if (!config.enabled) return null;
  async function request(path, body) {
    const response = await fetchImpl(`${config.url}${path}`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    let data;
    try { data = await response.json(); } catch { throw new Error('backend_invalid_response'); }
    if (!data || typeof data !== 'object') throw new Error('backend_invalid_response');
    return { status: response.status, data };
  }
  async function start() {
    const channelId = randomUUID();
    const begun = await request('/api/reporting', { action: 'start', channel_id: channelId });
    if (!begun.data.ok || typeof begun.data.session_token !== 'string') throw new Error(begun.data.error?.code ?? 'backend_unavailable');
    const sessionToken = begun.data.session_token;
    let pending = Promise.resolve();
    const bridge = {
      channelId, sessionToken, active: true, context: null, decision: null, timeline: [],
      tools: [...begun.data.tools.filter(tool => tool.name !== 'load_crew_profile'), ROUTE_TOOL],
      instructions: begun.data.instructions,
      record(title, detail) { this.timeline.push({ sequence: this.timeline.length + 1, title, detail, at: new Date().toISOString() }); },
      call(name, args) {
        const work = async () => {
          if (!this.active) return { ok: false, error: { code: 'interaction_ended' } };
          const result = name === 'route_request'
            ? await request('/api/decisions', { session_token: sessionToken, request: args.request })
            : await request('/api/reporting', { action: 'tool', session_token: sessionToken, name, arguments: args });
          if (result.data.crm_context) this.context = result.data.crm_context;
          if (name === 'route_request') {
            if (result.data.ok) {
              try {
                const refreshed = await request('/api/reporting', { action: 'tool', session_token: sessionToken, name: 'get_crm_context', arguments: {} });
                if (refreshed.data.ok && refreshed.data.crm_context) this.context = refreshed.data.crm_context;
              } catch { this.record('Queue refresh', 'The decision returned; current queue status could not be refreshed.'); }
            }
            this.decision = result.data;
            this.record('Four Decisions answers', `${result.data.outcome ?? result.data.error?.code ?? 'unavailable'} · ${result.data.route ?? 'no route'}`);
          } else {
            if (['resume_case', 'review_case', 'open_case', 'update_symptom', 'record_repair_outcome', 'close_case'].includes(name)) this.decision = null;
            this.record(name.replaceAll('_', ' '), result.data.ok ? 'CRM returned current context.' : (result.data.error?.code ?? 'unavailable'));
          }
          return result.data;
        };
        const result = pending.then(work);
        pending = result.catch(() => {});
        return result;
      },
      async end() {
        if (!this.active) return;
        this.active = false;
        await pending;
        try { await request('/api/reporting', { action: 'end', session_token: sessionToken }); }
        catch { this.record('Session end', 'Backend confirmation unavailable.'); }
        this.context = null;
        this.decision = null;
      },
      public() { return { active: this.active, context: this.context, decision: this.decision, timeline: this.timeline }; },
    };
    try {
      const loaded = await bridge.call('load_crew_profile', { spoken_code: PHRASE });
      if (!loaded.ok) throw new Error(loaded.error?.code ?? 'profile_unavailable');
      bridge.record('Avery profile loaded', 'Demo phrase accepted by CRM.');
      return bridge;
    } catch (error) { await bridge.end(); throw error; }
  }
  return { start };
}
