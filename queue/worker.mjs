import { CRMError } from '../crm/service.mjs';

const RESULT_KEYS = ['diagnosis', 'next_step', 'summary', 'source_id'];
const bounded = result => Object.fromEntries(RESULT_KEYS.flatMap(k => typeof result[k] === 'string' && result[k].trim() ? [[k, result[k].trim().slice(0, 300)]] : []));

/**
 * Runs one queued task through its specialist and then its reply. Specialist
 * handlers are injected: today fictional functions, tomorrow MCP clients.
 * A handler receives the bounded task payload and returns { ok, result }.
 */
export function createQueueWorker({ service, specialists = {}, replies = {} }) {
  const active = new Set();
  async function reply(taskId) {
    const prep = await service.prepareTaskReply(taskId);
    const channel = replies[prep.channel];
    if (!channel) return { ok: false, error: { code: 'reply_channel_unavailable' }, channel: prep.channel };
    return channel.deliver({ taskId });
  }
  return {
    reply,
    close: async () => { await Promise.allSettled([...active]); },
    run(taskId) {
      const work = runTask(taskId);
      active.add(work);
      work.then(() => active.delete(work), () => active.delete(work));
      return work;
    },
    async sweep() {
      const results = [];
      for (const due of await service.listRepliesDue()) {
        try { results.push({ task_id: due.id, ...await reply(due.id) }); }
        catch (error) { results.push({ task_id: due.id, ok: false, error: { code: error instanceof CRMError ? error.code : 'reply_failed' } }); }
      }
      return results;
    },
  };
  async function runTask(taskId) {
      const task = await service.getTaskAssignment(taskId);
      if (task.status !== 'working') return { ok: false, error: { code: 'task_not_pending' }, status: task.status };
      const handler = specialists[task.specialist];
      if (!handler) return { ok: false, error: { code: 'specialist_unavailable' }, specialist: task.specialist };
      let outcome = null;
      try { outcome = await handler(task); } catch { outcome = null; }
      const result = outcome?.ok && outcome.result && typeof outcome.result === 'object' ? bounded(outcome.result) : {};
      const ok = Object.keys(result).length > 0;
      const recorded = await service.recordTaskResult({ taskId, failed: !ok, result: ok ? result : { summary: `The ${task.specialist} desk could not finish this request.` } });
      let delivered = null;
      // Consent can arrive while the specialist is working. Use the row saved
      // with the result, rather than the assignment's earlier snapshot.
      if (recorded.status === 'result_ready' && recorded.reply_channel) {
        try { delivered = await reply(taskId); }
        catch (error) { delivered = { ok: false, error: { code: error instanceof CRMError ? error.code : 'reply_failed' } }; }
      }
      return { ok: true, status: recorded.status, reply: delivered };
  }
}
