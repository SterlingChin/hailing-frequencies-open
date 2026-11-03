import './style.css';
import { createRehearsal, presentation, transition } from './state.js';

const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
let state = createRehearsal();

function node(tag, content, className) {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function status(id, label, tone = '') {
  text(id, label); $(id).dataset.state = tone;
}

function render({ announce = false } = {}) {
  const view = presentation(state);
  text('caption', view.caption); text('speaker', view.speaker); text('phase', view.label);
  $('solution-source').hidden = state.phase !== 'solution_proposed';
  text('solution-source', state.phase === 'solution_proposed' ? `Source: ${state.context.source}. This case is still open until you confirm the repair worked.` : '');
  $('caption').dataset.phase = state.phase;
  status('connection', state.phase === 'call_placed' ? 'Simulation · callback attempt' : state.phase.startsWith('callback_') && state.callback.status === 'answered'
    ? 'Simulation · callback' : state.initialCall === 'open' ? 'Simulation · intake open'
      : state.initialCall === 'ended' ? 'Simulation · intake ended' : 'Simulation · standby');
  status('identity-state', state.identityConfirmed ? 'Demo profile loaded' : 'Identity not confirmed', state.identityConfirmed ? 'ready' : '');
  $('context-lock').hidden = Boolean(state.context);
  text('context-lock', state.identityConfirmed ? 'Identity confirmed in the fixture. CRM context is not loaded yet.' : 'CRM context is locked until the demo identity is confirmed.');
  $('context-content').hidden = !state.context;
  $('context-list').replaceChildren(); $('context-history').replaceChildren();
  if (state.context) {
    const context = state.context;
    for (const [label, value] of [['Crew', context.crew.name], ['Ship', context.crew.ship], ['Case', context.caseId], ['Equipment', context.equipment]]) {
      const row = document.createElement('div'); row.append(node('dt', label), node('dd', value)); $('context-list').append(row);
    }
    for (const [label, value] of [['Issue', context.issue], ['History', context.history], ['Queue at intake', context.queue], ['Solution source', context.source]]) {
      const paragraph = document.createElement('p'); paragraph.append(node('strong', `${label}: `), node('span', value)); $('context-history').append(paragraph);
    }
  }
  $('identity-form').hidden = !view.identityForm;
  text('identity-error', state.error); $('identity-error').hidden = !state.error;
  $('identity-code').setAttribute('aria-invalid', String(Boolean(state.error)));
  $('action-panel').hidden = !view.primary;
  $('next').hidden = !view.primary; $('next').disabled = !view.primary;
  text('next', view.primary?.[1] || ''); $('next').dataset.action = view.primary?.[0] || '';
  $('alternative').hidden = !view.secondary;
  text('alternative', view.secondary?.[1] || ''); $('alternative').dataset.action = view.secondary?.[0] || '';
  $('completion').hidden = state.caseStatus !== 'completed';

  const task = state.task;
  text('task-owner', task ? `${task.owner} · ${task.id}` : 'No specialist assigned');
  const taskLabel = { queued: 'Queued', working: 'Specialist working', result_ready: 'Result ready · case open', completed: 'Completed · caller confirmed' };
  status('task-status', task ? taskLabel[task.status] : 'Not queued', task?.status === 'completed' ? 'ready' : task?.status || '');
  $('task-card').dataset.state = task?.status || '';
  text('task-detail', task ? (task.finding || `${task.reused ? 'Existing task reused. ' : ''}${task.owner} owns the issue and any requested callback. No finding yet.`)
    : state.phase === 'solution_proposed' || state.caseStatus === 'completed' ? 'The reporting agent reuses the existing solution. No new specialist task or callback.'
      : 'The reporting agent handles intake. A usable existing solution can stay on this call.');
  $('assignment').hidden = !task;
  text('assignment-detail', task ? `${task.context.crew.name} · ${task.context.crew.ship}. ${task.context.caseId}: ${task.context.issue} ${task.context.equipment}. ${task.context.history} ${task.context.queue} ${task.context.source}` : '');
  const callback = state.callback;
  const callbackLabel = { not_requested: 'Not requested', requested: 'Callback requested', placed: 'Call placed · outcome unknown', answered: 'Call answered · not completed', no_answer: 'Call placed · no answer', completed: 'Completed · caller confirmed' };
  status('callback-status', callbackLabel[callback.status], callback.status === 'completed' ? 'ready' : callback.status === 'no_answer' ? 'unconfirmed' : '');
  text('callback-detail', callback.owner
    ? `Owner: ${callback.owner}. ${callback.consent ? 'Caller explicitly requested this callback.' : 'No active callback request.'} Demo communicator only. Attempts: ${callback.attempts}.`
    : 'A preference is not consent. No call is placed automatically.');
  text('case-status', state.caseStatus === 'completed' ? 'Case completed · caller confirmed in fixture' : 'Case open · fixture');

  // Append events without moving scroll or rebuilding earlier timeline entries.
  while ($('timeline').children.length > state.timeline.length) $('timeline').lastElementChild.remove();
  for (const event of state.timeline.slice($('timeline').children.length)) {
    const item = document.createElement('li'); item.className = 'hf-timeline__item';
    const body = document.createElement('div'); body.className = 'hf-timeline__body';
    body.append(node('strong', event.title), node('p', `${event.actor} · ${event.detail}`));
    item.append(node('span', `#${String(event.sequence).padStart(2, '0')}`, 'hf-timeline__time'), node('span', '•', 'hf-timeline__mark'), body);
    $('timeline').append(item);
  }
  $('timeline-empty').hidden = Boolean(state.timeline.length);
  if (announce) text('announcement', `${view.label}. ${view.caption}`);
}

function act(action, value) {
  const previousPhase = state.phase;
  state = transition(state, action, value);
  render({ announce: true });
  if (previousPhase !== state.phase) {
    $('identity-code').value = '';
    // Keep keyboard focus useful when the form or triggering action disappears.
    if (presentation(state).identityForm) $('identity-code').focus({ preventScroll: true });
    else if (presentation(state).primary) $('next').focus({ preventScroll: true });
    else $('caption').focus({ preventScroll: true });
  }
}
for (const id of ['next', 'alternative']) $(id).addEventListener('click', () => act($(id).dataset.action));
$('identity-form').addEventListener('submit', event => { event.preventDefault(); act('confirm_identity', $('identity-code').value); });
function reset() {
  state = createRehearsal($('scenario').value); $('identity-code').value = '';
  $('assignment').open = false; $('context-content').querySelector('details').open = false;
  $('timeline').replaceChildren(); render({ announce: true });
}
$('scenario').addEventListener('change', reset); $('reset').addEventListener('click', reset);
render();
