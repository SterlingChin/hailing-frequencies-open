import { contextText } from '../context/shared.mjs';

// Repository-declared capabilities, not a live tools/list observation. The
// reporting backend owns MCP discovery, authentication and execution.
export const EXPERT_TOOL_CATALOG = Object.freeze({
  source: 'expert-agents-mcp/src/experts/registry.ts and src/tools/index.ts',
  expert_arguments: { question: 'string, 1–20000 characters', context: 'string, at most 200000 characters' },
  lifecycle_tools: ['expert_collect', 'expert_status', 'expert_cancel', 'list_experts'],
  live_verified: false,
  tools: Object.freeze([
    Object.freeze({ name: 'expert_engineering', routes: ['it', 'maintenance'], description: 'Diagnose technical problems and propose repairs.' }),
    Object.freeze({ name: 'expert_research', routes: [], description: 'Research and analyze open-ended questions; not a routing destination.' }),
    Object.freeze({ name: 'expert_logistics', routes: [], description: 'Plan tasks and sequencing; not a routing destination.' }),
  ]),
});

export function classificationInput(contextText) {
  return `${contextText}\n\nDeclared expert tools (availability is not live-verified):\n${JSON.stringify(EXPERT_TOOL_CATALOG)}\nThe reporting agent executes tools. Decide whether to use a stored solution, gather context, or hand off to IT/Maintenance; do not infer that queued work has started.`;
}

/** Pure handoff: no MCP client, dispatch hook, provider call or callback. */
export function reportingAction(decision) {
  const context = decision.context ?? null;
  let action = null;
  let nextAction = 'No new work is confirmed. Explain that routing is unavailable or needs review. This is not a request for more caller details: do not ask another troubleshooting question or automatically resubmit the same conversation. Do not invent a solution or promise a callback.';
  if (decision.outcome === 'solution' && decision.solution) {
    action = { type: 'respond', solution: decision.solution };
    nextAction = 'Explain the returned stored answer using context. Say the problem is fixed only when solution.confirmed_fixed is true; otherwise share the finding and ask whether it helped.';
  } else if (decision.outcome === 'needs_more_details') {
    action = { type: 'gather_context' };
    nextAction = context?.version === 2
      ? 'Ask one focused question about an unanswered fact essential to routing, using all prior context; do not repeat answered questions or ask for extra troubleshooting once the issue and destination are clear. Then send the same crew_member_id and fuller conversation text as context to Decisions. The new blob will be saved in CRM before a fresh decision.'
      : 'Ask one focused question about an unanswered fact essential to routing, using all prior context; do not repeat answered questions or ask for extra troubleshooting once the issue and destination are clear. Save any changed symptom in CRM, then explicitly request a fresh decision with the fuller request.';
  } else if (decision.outcome === 'queue' && decision.task) {
    const task = decision.task;
    const tool = EXPERT_TOOL_CATALOG.tools.find(item => item.routes.includes(task.specialist));
    // Reused work keeps the ORIGINAL assignment and context, even when a later
    // caller request yields a fresher decision.context. Never rewrite a handoff.
    const snapshot = task.context_snapshot;
    if (tool && snapshot) {
      action = {
        type: 'route_to_expert', desk: task.specialist, task_id: task.id,
        dispatch_key: task.id,
        dispatch_policy: decision.reused ? 'reconcile_existing' : 'claim_before_dispatch',
        tool_call: { name: tool.name, arguments: { question: `${task.specialist}: ${contextText(task.assignment)}`, context: JSON.stringify(snapshot) } },
      };
      nextAction = decision.reused
        ? 'Reconcile this task_id with the reporting backend’s saved MCP dispatch before any call. Reuse an existing dispatch; do not automatically send the handoff again. CRM working means pending, not proof of expert execution.'
        : 'The handoff is saved. The reporting backend must confirm tool availability, durably claim dispatch_key, then make the proposed MCP call with its context argument. Do not claim the expert started or promise a callback without separate confirmation.';
    } else {
      nextAction = 'The task is saved but has no supported tool or context snapshot. Reconcile it before dispatch; do not invent an MCP call.';
    }
  }
  return { context, crm_context: context, action, tool_catalog: EXPERT_TOOL_CATALOG, next_action: nextAction };
}
