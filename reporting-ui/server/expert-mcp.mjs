import { createDispatchStore } from './dispatch-store.mjs';
import { randomUUID } from 'node:crypto';
const VERSION = '2026-07-28';
/** Stateless MCP. Discovery precedes every dispatch; no Tasks extension is
 * negotiated, so inline answers and investigation acknowledgments stay distinct. */
export function createExpertRouter({ env = process.env, fetchImpl = fetch, dispatchStore = env.EXPERT_DISPATCH_DIR ? createDispatchStore({ directory: env.EXPERT_DISPATCH_DIR }) : null } = {}) {
  const endpoint = env.EXPERT_MCP_URL || 'https://web-dev-challenge-production.up.railway.app/mcp';
  const token = env.SPECIALISTS_MCP_TOKEN?.trim();
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Expert MCP requires HTTPS.');
  const jobs = new Map();
  async function rpc(method, params) {
    const id = randomUUID();
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION, 'Mcp-Method': method, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientInfo': { name: 'hailing-reporting', version: '1.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    if (!response.ok) throw new Error('mcp_transport_rejected');
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('mcp_response_too_large');
    let message;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { const item = JSON.parse(data); if (item.id === id) message = item; } catch { /* Ignore non-JSON stream notifications. */ }
      }
    } else message = JSON.parse(text);
    if (!message || message.id !== id || message.error || !message.result) throw new Error('mcp_protocol_failed');
    return message.result;
  }
  function projection(result, initial) {
    if (result.isError) return { ...initial, status: 'failed', message: 'The expert could not complete this request.' };
    const data = result.structuredContent;
    if (data?.outcome === 'ANSWERED' && typeof data.answer === 'string' && data.answer.trim()) return { ...initial, status: 'answer_ready', answer: data.answer.slice(0, 20000) };
    if (data?.outcome === 'EXPERT_AGENT_DISPATCHED' && typeof data.dispatchId === 'string') return { ...initial, status: 'dispatched', dispatchId: data.dispatchId, message: 'Expert investigation accepted. No completed result yet.' };
    if (data?.status === 'completed' && typeof data.report === 'string' && data.report.trim()) return { ...initial, status: 'answer_ready', answer: data.report.slice(0, 20000) };
    if (['failed', 'cancelled'].includes(data?.status)) return { ...initial, status: data.status };
    if (data?.status === 'working') return { ...initial, status: 'working', message: typeof data.latestStatus === 'string' ? data.latestStatus.slice(0, 500) : 'Expert reports work in progress.' };
    return { ...initial, status: 'unconfirmed', message: 'No expert answer or dispatch was confirmed.' };
  }
  return {
    dispatch(decision, request, isCancelled = () => false) {
      if (decision.outcome !== 'queue' || !decision.task_id) return Promise.resolve(null);
      if (jobs.has(decision.task_id) && !decision.reused && decision.action?.dispatch_policy !== 'reconcile_existing') return jobs.get(decision.task_id);
      const initial = { taskId: decision.task_id, route: decision.route, status: 'requesting' };
      const job = (async () => {
        let calling = false, claimOwner, dispatchKey;
        const reconciled = record => record?.result ? { ...record.result, dispatchKey } : { ...initial, dispatchKey, status: record ? 'unconfirmed' : 'existing_task', message: record ? 'A dispatch claim exists without a confirmed receipt. No duplicate expert call was made.' : 'Existing task has no saved dispatch receipt. No duplicate expert call was made.' };
        try {
          const handoff = decision.action?.tool_call;
          if (handoff) {
            dispatchKey = decision.action.dispatch_key;
            if (!dispatchStore || typeof dispatchKey !== 'string' || !dispatchKey) throw new Error('Dispatch storage or key missing');
            if (decision.reused || decision.action.dispatch_policy === 'reconcile_existing') return reconciled(await dispatchStore.read(dispatchKey));
            if (decision.action.dispatch_policy !== 'claim_before_dispatch') throw new Error('Unknown dispatch policy');
          } else if (decision.reused) return reconciled(null);
          const catalog = await rpc('tools/list', {});
          const candidates = Array.isArray(catalog.tools) ? catalog.tools : [];
          const name = handoff ? candidates.find(tool => tool.name === handoff.name)?.name : candidates.find(tool => tool.name === decision.route || tool.name === `expert_${decision.route}`)?.name;
          if (!name) return { ...initial, status: 'tool_unavailable', message: `No ${decision.route} tool is advertised by the expert server.` };
          const schema = candidates.find(tool => tool.name === name).inputSchema;
          if (schema?.properties?.question?.type !== 'string' || schema.required?.some(key => !['question', 'context'].includes(key))) return { ...initial, status: 'tool_unavailable', message: 'Expert tool arguments are not supported.' };
          const question = handoff ? handoff.arguments?.question : request;
          if (typeof question !== 'string' || !question.trim() || question.length > Math.min(schema.properties.question.maxLength || 20000, 20000)) return { ...initial, status: 'failed', message: 'Expert question exceeds the tool contract.' };
          const args = { question };
          if (schema.properties.context?.type === 'string') {
            const context = handoff ? handoff.arguments?.context : JSON.stringify(decision.crm_context ?? {});
            if (typeof context !== 'string') return { ...initial, status: 'failed', message: 'Expert context does not match the tool contract.' };
            if (context.length > Math.min(schema.properties.context.maxLength || 200000, 200000)) return { ...initial, status: 'failed', message: 'CRM context exceeds the expert tool limit.' };
            args.context = context;
          }
          if (isCancelled()) return { ...initial, status: 'cancelled', message: 'Channel ended before expert dispatch.' };
          if (handoff) {
            const claim = await dispatchStore.claim(dispatchKey);
            if (!claim.claimed) return reconciled(claim.record);
            claimOwner = claim.owner;
            if (isCancelled()) { const result = { ...initial, dispatchKey, status: 'cancelled' }; await dispatchStore.save(dispatchKey, claimOwner, result); return result; }
          }
          calling = true;
          const result = projection(await rpc('tools/call', { name, arguments: args }), { ...initial, tool: name, ...(dispatchKey ? { dispatchKey } : {}) });
          if (claimOwner) await dispatchStore.save(dispatchKey, claimOwner, result);
          return result;
        } catch {
          // A lost response after tools/call may still have started work. Never retry.
          const result = { ...initial, ...(dispatchKey ? { dispatchKey } : {}), status: calling ? 'unconfirmed' : 'unavailable', message: calling ? 'Expert request outcome is unknown. No automatic retry was made.' : 'Expert discovery or dispatch claim could not finish.' };
          if (claimOwner) { try { await dispatchStore.save(dispatchKey, claimOwner, result); } catch { /* Existing durable claim prevents replay even without a receipt. */ } }
          return result;
        }
      })();
      jobs.set(decision.task_id, job);
      return job;
    },
    async refresh(current) {
      if (!current?.dispatchId || !['dispatched', 'working'].includes(current.status)) return current;
      try {
        const catalog = await rpc('tools/list', {});
        if (!catalog.tools?.some(tool => tool.name === 'expert_collect')) return current;
        const result = projection(await rpc('tools/call', { name: 'expert_collect', arguments: { dispatchId: current.dispatchId } }), current);
        if (current.dispatchKey && dispatchStore) { const record = await dispatchStore.read(current.dispatchKey); if (record?.owner) await dispatchStore.save(current.dispatchKey, record.owner, result); }
        return result;
      } catch { return { ...current, message: 'Expert progress could not be refreshed.' }; }
    },
  };
}
