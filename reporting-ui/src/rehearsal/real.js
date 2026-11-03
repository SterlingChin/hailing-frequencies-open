const $ = id => document.getElementById(id);
const node = (tag, value) => { const element = document.createElement(tag); element.textContent = String(value ?? ''); return element; };
let csrf, state = { active: false, context: null, decision: null, timeline: [] }, busy = false;
function suggestedRequest(selected, scenario) {
  const issue = selected.symptom.trim().replace(/[.!?]+$/, '');
  if (scenario === 'it') return `${issue}. Please ask IT to investigate.`;
  if (scenario === 'maintenance') return `${issue}. Please ask Maintenance to investigate.`;
  return `${issue}. Can you use a saved repair for this same issue? Please tell me the steps, and I will confirm whether they worked.`;
}
async function request(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {},
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The server could not finish this step.');
  return data;
}
function status(message) { $('announcement').textContent = message; $('rehearsal-error').textContent = message; $('rehearsal-error').hidden = !message; }
async function action(value) {
  if (busy) return;
  busy = true; render(); status('');
  try { state = await request('/api/rehearsal', value); render(); }
  catch (error) { status(error.message); }
  finally { busy = false; render(); }
}
function button(label, value = null, kind = 'primary') {
  const element = node('button', label); element.type = 'button'; element.className = 'hf-action'; element.dataset.kind = kind;
  element.disabled = busy; if (value) element.addEventListener('click', () => void action(value)); return element;
}
function field(label, element) {
  const wrapper = node('label', label); wrapper.append(element); return wrapper;
}
function suggestedReply(decision, selected) {
  const caseLabel = selected?.id ? `Case ${selected.id}: ` : '';
  if (decision.outcome === 'solution' && decision.solution?.result) {
    const result = decision.solution.result;
    return `${caseLabel}${result.diagnosis ?? 'We have a stored finding for this issue.'} ${result.next_step ?? ''} Please tell me whether that resolves it.`.trim();
  }
  if (decision.outcome === 'queue') return `${caseLabel}${decision.reused ? 'Your request is already in' : 'I have added your request to'} the ${decision.route === 'it' ? 'IT' : 'Maintenance'} queue. The task is open and its result is pending. No reply channel has been requested in this rehearsal; the result can be reviewed here when available.`;
  if (decision.outcome === 'needs_more_details') return `${caseLabel}I need one more detail before routing this issue. What happened just before the problem started?`;
  return `${caseLabel}I cannot confirm a route yet. I will keep the case open and review the request without promising a fix or callback.`;
}
function render() {
  const context = state.context, profile = context?.profile, selected = context?.selected_case, decision = state.decision;
  $('rehearsal-badge').textContent = 'REAL ENDPOINTS · FICTIONAL CREW';
  $('rehearsal-notice').textContent = 'Start with fictional Avery Chen’s CRM context, ask the four live Decisions questions, then inspect the suggested reply and queue state. This page changes the real Railway demo CRM; it does not place calls or send messages.';
  $('rehearsal-footer').textContent = 'REAL RAILWAY CRM + DECISIONS / Fictional crew / No voice or messaging';
  $('scenario-hint').textContent = 'This only changes the suggested request; it does not change CRM data.';
  $('timeline-badge').textContent = 'BACKEND EVENTS';
  $('context-content').querySelector('.context-audience').textContent = 'This is the same stored context sent to Decisions and any queued specialist.';
  document.querySelector('.hf-followup .hf-card__title').textContent = 'Reply channel';
  $('scenario').options[1].textContent = 'IT queue and reuse';
  $('scenario').options[2].textContent = 'New Maintenance queue';
  $('reset').textContent = 'End session'; $('reset').disabled = busy || !state.active;
  $('scenario').disabled = busy;
  $('identity-form').hidden = true;
  $('context-lock').hidden = Boolean(profile);
  $('context-lock').textContent = 'Start an Avery session to load the CRM profile.';
  $('context-content').hidden = !profile;
  $('identity-state').textContent = profile ? 'Demo profile loaded by CRM' : 'No CRM session';
  $('connection').textContent = state.active ? 'Railway session open' : 'Standby';
  $('speaker').textContent = 'CONTEXT → DECISIONS → REPLY';
  $('phase').textContent = selected ? `Case ${selected.id} · ${selected.status}` : profile ? 'Select or open a case' : 'Start from Avery';
  $('caption').textContent = decision ? `${decision.outcome || 'Unavailable'}${decision.route ? ` · ${decision.route}` : ''}`
    : selected ? selected.symptom : profile ? 'CRM context loaded. Select Avery’s case or report a new issue.' : 'Hailing frequencies open.';
  $('solution-source').hidden = !selected?.solution;
  $('solution-source').textContent = selected?.solution ? `Saved answer: ${JSON.stringify(selected.solution.result)}. Caller-confirmed fix: ${selected.solution.confirmed_fixed ? 'yes' : 'no'}.` : '';
  $('context-list').replaceChildren(); $('context-history').replaceChildren();
  if (profile) {
    for (const [label, value] of [['Crew', `${profile.rank} ${profile.display_name}`], ['Ship', profile.ship], ['Case', selected?.id ?? 'None selected'], ['Equipment', profile.equipment?.map(item => item.model).join(', ') ?? 'None']]) {
      const row = node('div', ''); row.append(node('dt', label), node('dd', value)); $('context-list').append(row);
    }
    for (const [label, value] of [['Current issue', selected?.symptom ?? 'No case selected'], ['History', selected?.brief ?? 'Select a case to view its stored history.'],
      ['Queue', context.queue?.length ? context.queue.map(task => `${task.specialist}: ${task.status} (${task.id})`).join('; ') : 'No active task'],
      ['Stored solution', selected?.solution ? JSON.stringify(selected.solution.result) : 'None for this case and symptom']]) {
      const paragraph = node('p', ''); paragraph.append(node('strong', `${label}: `), node('span', value)); $('context-history').append(paragraph);
    }
  }
  const panel = $('action-panel'); panel.replaceChildren(node('p', 'Real workflow controls'));
  if (!state.active) panel.append(button('Start Avery CRM session', { action: 'start' }));
  else {
    if (!selected) {
      const cases = [...(profile?.open_cases ?? []), ...(profile?.recent_cases ?? [])];
      if (cases.length) {
        const picker = document.createElement('select'); picker.id = 'real-case-picker';
        for (const item of cases) { const option = document.createElement('option'); option.value = item.caseId; option.textContent = `${item.caseId} · ${item.status} · ${item.title}`; picker.append(option); }
        panel.append(field('Avery’s existing cases ', picker));
        const select = button('Confirm and load selected case');
        select.onclick = () => { const chosen = cases.find(item => item.caseId === picker.value);
          void action({ action: 'select_case', case_id: chosen.caseId, caller_confirmed: true, review_only: chosen.status !== 'open' }); };
        panel.append(select);
      }
      if (profile?.equipment?.length) {
        const equipment = document.createElement('select'); for (const item of profile.equipment) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.model} · ${item.location}`; equipment.append(option); }
        const symptom = document.createElement('input'); symptom.value = $('scenario').value === 'maintenance' ? 'Replicator stops halfway through every order' : $('scenario').value === 'it' ? 'RPL-2400 control panel sign-in fails on Deck 7' : '';
        symptom.maxLength = 300; panel.append(field('Equipment ', equipment), field('New issue ', symptom));
        const open = button('Open a new case'); open.onclick = () => void action({ action: 'open_case', equipment_id: equipment.value, symptom: symptom.value }); panel.append(open);
      }
    } else {
      const requestText = document.createElement('textarea'); requestText.id = 'real-request'; requestText.maxLength = 300;
      requestText.value = suggestedRequest(selected, $('scenario').value); panel.append(field('Caller request to Decisions ', requestText));
      const decide = button('Ask the four Decisions questions'); decide.onclick = () => void action({ action: 'decide', request: requestText.value }); panel.append(decide);
      panel.append(button('Refresh CRM and queue', { action: 'refresh' }, 'secondary'));
      if (selected.solution) {
        panel.append(button('Caller says repair worked', { action: 'outcome', outcome: 'confirmed_fixed', caller_confirmed: true }, 'secondary'));
        panel.append(button('Caller says still broken', { action: 'outcome', outcome: 'not_fixed', caller_confirmed: true }, 'secondary'));
      }
      if (selected.status === 'open') panel.append(button('Caller asks to close case', { action: 'close_case', caller_confirmed: true }, 'secondary'));
    }
  }
  $('real-answer').hidden = !decision;
  $('real-answer-list').replaceChildren();
  if (decision) {
    $('real-evaluated-request').textContent = `Evaluated request: ${decision.crm_context?.request ?? 'Not returned by Decisions'}`;
    for (const [label, value] of [
      ['Route', `${decision.answers?.route?.value ?? 'unavailable'} · confidence ${decision.answers?.route?.confidence ?? 'unavailable'}`],
      ['Resolvable now', decision.answers?.resolvable_now ?? 'unavailable'],
      ['Needs more details', decision.answers?.needs_more_details ?? 'unavailable'],
      ['Urgency', `${decision.answers?.urgency?.label ?? 'unavailable'} · score ${decision.answers?.urgency?.score ?? 'unavailable'}`],
    ]) { const row = node('div', ''); row.append(node('dt', label), node('dd', value)); $('real-answer-list').append(row); }
    $('real-reply').textContent = suggestedReply(decision, selected);
    $('real-next-action').textContent = `${decision.next_action ?? ''}${decision.task_id ? ` Task ${decision.task_id}${decision.reused ? ' reused.' : ' created.'}` : ''}`;
  }
  const task = context?.queue?.[0];
  $('task-owner').textContent = task ? `${task.specialist.toUpperCase()} · ${task.id}` : 'No specialist assigned';
  $('task-status').textContent = task?.status === 'working' ? 'Open task · result pending' : task?.status ?? 'Not queued'; $('task-detail').textContent = task?.result ? JSON.stringify(task.result) : task?.assignment ?? 'No finding yet.';
  $('assignment').hidden = !task; $('assignment-detail').textContent = task ? context.text : '';
  $('callback-status').textContent = 'No callback transport';
  $('callback-detail').textContent = 'This browser rehearsal does not have a calling number. Queue state can be tested without placing a call.';
  $('case-status').textContent = selected ? `Case ${selected.status} · CRM` : 'No case selected';
  $('completion').hidden = true; $('timeline-empty').hidden = Boolean(state.timeline?.length);
  $('timeline').replaceChildren(...(state.timeline ?? []).map(event => {
    const row = node('li', ''); row.className = 'hf-timeline__item'; const body = node('div', ''); body.className = 'hf-timeline__body';
    const time = node('span', `#${String(event.sequence).padStart(2, '0')}`); time.className = 'hf-timeline__time';
    const mark = node('span', '•'); mark.className = 'hf-timeline__mark';
    body.append(node('strong', event.title), node('p', `${event.at} · ${event.detail}`)); row.append(time, mark, body); return row;
  }));
  const recap = $('recap-title').parentElement.nextElementSibling;
  recap.textContent = decision ? `Four live answers: route ${decision.answers?.route?.value ?? 'n/a'} (${decision.answers?.route?.confidence ?? 'n/a'}), resolvable now ${decision.answers?.resolvable_now ?? 'n/a'}, needs more details ${decision.answers?.needs_more_details ?? 'n/a'}, urgency ${decision.answers?.urgency?.label ?? 'n/a'} (${decision.answers?.urgency?.score ?? 'n/a'}). Outcome: ${decision.outcome ?? 'unavailable'}; reused task: ${decision.reused ? 'yes' : 'no'}.`
    : 'The four Decisions answers will appear here after a case is selected and evaluated.';
}
async function initialize() {
  $('scenario').addEventListener('change', render);
  $('reset').addEventListener('click', () => void action({ action: 'end' }));
  const session = await request('/api/session'); csrf = session.csrf;
  state = await request('/api/rehearsal'); render();
}
void initialize().catch(error => status(error.message));
