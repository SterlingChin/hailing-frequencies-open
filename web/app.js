const byId = id => document.getElementById(id);
const labels = { connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', ended: 'Ended', failed: 'Failed', working: 'Working', result_ready: 'Result ready', obsolete: 'Replaced', requested: 'Requested', queued: 'Queued', submitted: 'Submitted · delivery not confirmed', sent: 'Sent · delivery not confirmed', delivered: 'Delivered', undelivered: 'Undelivered', unavailable: 'SMS unavailable', not_requested: 'Not requested' };
const text = (id, value) => { byId(id).textContent = value ?? ''; };
const element = (tag, className, value) => { const node = document.createElement(tag); node.className = className; if (value != null) node.textContent = value; return node; };
function status(node, state, prefix = '') {
  node.dataset.state = state === 'result_ready' ? 'ready' : state === 'obsolete' ? 'replaced' : state === 'unavailable' ? 'unconfirmed' : state;
  node.textContent = prefix + (labels[state] ?? 'Unknown');
}
let source, lastEventId = '', paused = false, completed = false, taskJSON = '', timelineIds = new Set();
function render(state) {
  if (state.source !== 'fixture') return; // Live data requires a separate, authorized case subscription.
  status(byId('connection'), state.connection, 'Fixture · ');
  text('speaker-name', state.speaker.name); text('speaker-state', state.speaker.state);
  byId('speaker').dataset.role = state.speaker.role; text('caption', state.caption);
  text('profile-state', state.crew?.state ?? 'No profile loaded');
  text('crew-name', state.crew?.name ?? 'Waiting for authorization'); text('ship', state.crew?.ship ?? '—');
  text('equipment', state.crew?.equipment ?? '—'); text('history', state.crew?.history ?? 'No history loaded.');
  text('preferences', state.crew?.preference ?? 'A channel preference never sends a message.');
  text('case-id', state.case ? `${state.case.id} · ${state.case.status} · revision ${state.case.revision}` : 'No case selected');
  text('symptom', state.case?.symptom ?? '—');
  byId('next-step').hidden = !state.nextStep; byId('waiting').hidden = Boolean(state.nextStep);
  if (state.nextStep) { text('next-title', state.nextStep.label); text('next-text', state.nextStep.text); text('next-status', state.nextStep.status); text('next-source', `Source: ${state.nextStep.source}`); }
  if (taskJSON !== JSON.stringify(state.tasks)) {
    taskJSON = JSON.stringify(state.tasks);
    const cards = state.tasks.map(task => {
      const card = element('article', 'hf-card hf-task hf-stack'); card.dataset.specialist = task.specialist; card.dataset.state = task.status === 'obsolete' ? 'replaced' : task.status;
      const head = element('div', 'hf-card__head'); head.append(element('h3', 'hf-card__title', task.specialist === 'engineering' ? 'Engineering' : 'Logistics'));
      const pill = element('span', 'hf-status'); status(pill, task.status); head.append(pill);
      card.append(head, element('p', '', task.assignment));
      if (task.finding) card.append(element('p', 'hf-small hf-muted', task.finding));
      return card;
    });
    byId('tasks').replaceChildren(...(cards.length ? cards : [element('p', 'hf-muted', 'No specialist assigned yet.')]));
  }
  status(byId('message-status'), state.message.status); text('message-text', state.message.text);
  text('message-destination', state.message.destination); byId('summary-box').hidden = !state.message.summary;
  text('repair-summary', state.message.summary);
  // Append without focus changes or scrollIntoView: readers keep their place.
  for (const event of state.timeline) {
    if (timelineIds.has(event.id)) continue;
    timelineIds.add(event.id);
    const item = element('li', 'hf-timeline__item'); item.dataset.kind = event.kind;
    const mark = element('span', 'hf-timeline__mark', event.kind === 'task' ? 'T' : event.kind === 'message' ? 'M' : '•'); mark.setAttribute('aria-hidden', 'true');
    const body = element('div', 'hf-timeline__body'); body.append(element('strong', '', event.actor), element('p', '', event.text));
    item.append(element('span', 'hf-timeline__time', event.time), mark, body); byId('timeline').append(item);
  }
}
function connect({ reset = false } = {}) {
  source?.close(); paused = false; completed = false;
  text('pause', 'Pause preview'); text('feed-status', 'Connecting to preview…');
  if (reset) { lastEventId = ''; timelineIds = new Set(); byId('timeline').replaceChildren(); taskJSON = ''; text('copy-status', ''); }
  const query = new URLSearchParams({ scenario: byId('scenario').value });
  if (lastEventId) query.set('after', lastEventId);
  source = new EventSource(`/events?${query}`);
  source.addEventListener('snapshot', event => {
    try { const state = JSON.parse(event.data); render(state); lastEventId = event.lastEventId; text('feed-status', 'Fixture feed connected'); }
    catch { text('feed-status', 'Preview data unavailable'); }
  });
  source.addEventListener('complete', () => { source.close(); completed = true; text('feed-status', 'Fixture complete · recap retained'); text('pause', 'Replay preview'); });
  source.onerror = () => { text('feed-status', 'Preview feed interrupted · reconnecting'); status(byId('connection'), 'reconnecting', 'Preview · '); text('speaker-state', 'Waiting for the fixture feed'); };
}
byId('scenario').addEventListener('change', () => connect({ reset: true }));
byId('replay').addEventListener('click', () => connect({ reset: true }));
byId('pause').addEventListener('click', () => {
  if (completed) return connect({ reset: true });
  if (paused) return connect();
  source.close(); paused = true; text('pause', 'Resume preview'); text('feed-status', 'Preview paused · last fixture state shown');
});
byId('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(byId('repair-summary').textContent); text('copy-status', 'Repair summary copied.'); }
  catch { text('copy-status', 'Select the repair summary above and copy it with your keyboard.'); }
});
window.addEventListener('pagehide', () => source?.close());
connect();
