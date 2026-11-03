export function contextSummary(state) {
  const context = state.crmContext, decision = state.decision;
  const selected = context?.selected_case || (Array.isArray(context?.cases) ? context.cases.find(item => item.id === decision?.issue || item.id === state.report?.caseId) : null);
  return {
    status: ['loading', 'deciding'].includes(state.contextStatus) ? state.contextStatus === 'deciding' ? 'Getting recommendation…' : 'Loading context…' : state.contextStatus === 'ready' ? (state.active ? 'Context loaded' : 'Last recorded context') : state.contextStatus && state.contextStatus !== 'idle' ? 'Context could not be loaded' : 'Awaiting authorization',
    case: selected ? `${selected.id} · ${selected.status || 'Recorded'}` : 'No case selected',
    issue: selected?.symptom || 'Confirm an existing case or describe a new issue.',
    decision: !decision ? 'No recommendation yet' : decision.outcome === 'queue' ? `${decision.route === 'it' ? 'IT' : decision.route === 'maintenance' ? 'Maintenance' : 'Specialist'} · ${decision.reused ? 'existing task retained' : 'task recorded'}` : decision.outcome === 'solution' ? 'Stored answer available' : decision.outcome === 'needs_more_details' ? 'More details needed' : 'No route confirmed',
    detail: decision?.outcome === 'queue' ? 'Expert activity and delivery are not confirmed.' : decision?.next_action || '',
    tasks: (Array.isArray(context?.queue) ? context.queue : Array.isArray(context?.tasks) ? context.tasks : []).map(task => ({ id: task.id, specialist: task.specialist, status: task.status === 'working' ? 'Pending · activity not confirmed' : task.status === 'result_ready' ? 'Result available' : task.status || 'Recorded' })),
  };
}
export function renderContext(state) {
  const $ = id => document.getElementById(id), summary = contextSummary(state), context = state.crmContext;
  $('context-section').hidden = !state.authorized && !context;
  for (const [id, value] of [['context-status', summary.status], ['context-case', summary.case], ['context-issue', summary.issue], ['decision-title', summary.decision], ['decision-detail', summary.detail]]) $(id).textContent = value;
  const expert = state.expert;
  $('expert-title').textContent = !expert ? 'No expert requested' : ({ requesting: 'Contacting expert…', answer_ready: 'Expert answer available', dispatched: 'Expert investigation accepted', working: 'Expert reports work in progress', existing_task: 'Existing task retained', tool_unavailable: 'Expert tool not available', failed: 'Expert request failed', cancelled: 'Expert request cancelled', unconfirmed: 'Expert outcome unconfirmed', unavailable: 'Expert connection unavailable' }[expert.status] || 'Expert status unknown');
  $('expert-detail').textContent = expert?.answer || expert?.message || '';
  $('expert-card').hidden = !expert;
  $('refresh-context').disabled = !state.active || !state.authorized || ['loading', 'deciding'].includes(state.contextStatus);
  const element = (tag, text) => { const result = document.createElement(tag); result.textContent = text; return result; };
  $('context-equipment').replaceChildren(...(context?.profile?.equipment || []).map(item => element('li', [item.model, item.location].filter(Boolean).join(' · '))));
  $('context-cases').replaceChildren(...(Array.isArray(context?.cases) ? context.cases : [...(context?.profile?.open_cases || []), ...(context?.profile?.recent_cases || [])]).map(item => element('li', [item.caseId || item.id, item.title, item.brief].filter(Boolean).join(' · '))));
  $('context-tasks').replaceChildren(...summary.tasks.map(task => element('li', [task.specialist, task.status, task.id].filter(Boolean).join(' · '))));
  $('context-solution').textContent = context?.selected_case?.solution?.result ? Object.values(context.selected_case.solution.result).filter(value => typeof value === 'string').join(' ') : decisionSolution(state.decision);
  $('context-solution').hidden = !$('context-solution').textContent;
}
function decisionSolution(decision) { return decision?.solution?.result ? Object.values(decision.solution.result).filter(value => typeof value === 'string').join(' ') : ''; }
