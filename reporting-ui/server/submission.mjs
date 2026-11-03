/** PR12 trusted intake. The model supplies confirmed conversation text, never
 * caller identity, case selection, routing or credentials. One POST per draft
 * revision; uncertain outcomes are retained and never automatically replayed. */
export function createSubmission({ state, client, expertRouter, notify = () => {} }) {
  let ended = false;
  const submissions = new Map();
  const fail = code => ({ ok: false, error: { code } });
  return {
    async submit({ report_id, report_revision, context, caller_confirmed }) {
      if (ended) return fail('channel_ended');
      if (!state.authorized) return fail('identity_required');
      const report = state.report;
      if (!report || report.id !== report_id || report.revision !== report_revision) return fail('report_changed');
      if (caller_confirmed !== true) return fail('spoken_confirmation_required');
      if (typeof context !== 'string' || !context.trim() || context.length > 64000 || context.includes('\0') || !context.isWellFormed()) return fail('invalid_context');
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(state.crewMemberId || '')) return fail('identity_id_missing');
      const blob = `Confirmed issue: ${report.issue}\nLocation: ${report.location || 'Not specified'}\nConversation:\n${context}`;
      if (blob.length > 64000) return fail('invalid_context');
      if (submissions.has(report_revision)) return submissions.get(report_revision);
      let recordedResult;
      const work = (async () => {
        state.contextStatus = 'deciding'; state.expert = null; notify();
        const result = await client.submit(state.crewMemberId, blob);
        if (!result.ok) { report.delivery = result.error?.code === 'crew_member_not_found' && result.error.reason === 'ship_not_found' ? 'rejected' : 'unconfirmed'; state.contextStatus = result.error?.code || 'reporting_unavailable'; notify(); return result; }
        if (typeof result.context_id !== 'string' || !result.context_id) { report.delivery = 'unconfirmed'; notify(); return fail('submission_receipt_missing'); }
        recordedResult = result;
        report.delivery = 'recorded'; report.confirmed = true; report.contextId = result.context_id; report.updatedAt = new Date().toISOString();
        state.decision = result; state.crmContext = result.context ?? result.crm_context ?? null; state.contextUpdatedAt = new Date().toISOString(); state.contextStatus = 'ready'; notify();
        if (ended) return { ...result, expert: null };
        if (result.action?.type === 'route_to_expert' && expertRouter) {
          state.expert = { status: 'requesting', route: result.action.desk, taskId: result.action.task_id }; notify();
          const decision = { ...result, outcome: 'queue', task_id: result.action.task_id, route: result.action.desk, reused: result.action.dispatch_policy === 'reconcile_existing', crm_context: result.context ?? result.crm_context };
          const expert = await expertRouter.dispatch(decision, context, () => ended);
          state.expert = expert; result.expert = expert; notify();
        }
        return result.outcome === 'undecided' ? { ...result, reporter_next_step: { type: 'gather_context', instruction: 'The report is recorded but the service has not decided. Ask one specific question to clarify the caller’s issue. Wait for their answer, retain all previous details, capture the expanded issue, read it back and ask Is that correct? After a new explicit confirmation, submit the updated draft and complete conversation again. Repeat this conversation loop for every undecided response; do not stop at Okay or claim an expert was dispatched. Never resubmit without additional caller information and confirmation.' } } : result;
      })().catch(() => { if (recordedResult) { state.expert = { status: 'unconfirmed', message: 'Report recorded; expert request outcome is unconfirmed. No automatic retry was made.' }; state.contextStatus = 'ready'; notify(); return { ...recordedResult, expert: state.expert }; } report.delivery = 'unconfirmed'; state.contextStatus = 'reporting_unavailable'; notify(); return fail('submission_outcome_unknown'); });
      submissions.set(report_revision, work);
      return work;
    },
    end() { ended = true; },
  };
}
