import { DEMO_CODE, fixtureContext, scenarios } from './fixtures.js';

// Local rehearsal state, deliberately separate from every service contract.
export function createRehearsal(scenario = 'solution') {
  if (!Object.hasOwn(scenarios, scenario)) throw new Error('Unknown rehearsal scenario');
  return {
    fixture: true, scenario, phase: 'ready', identityConfirmed: false, context: null,
    caseStatus: 'open', initialCall: 'not_started', task: null,
    callback: { status: 'not_requested', owner: null, consent: false, attempts: 0, identityConfirmed: false },
    timeline: [], error: '',
  };
}

function record(state, title, actor, detail) {
  state.timeline.push({ sequence: state.timeline.length + 1, phase: state.phase, title, actor, detail });
}

export function transition(current, action, value) {
  const state = structuredClone(current);
  const fixture = scenarios[state.scenario];
  state.error = '';
  const at = phase => state.phase === phase;
  if (action === 'begin' && at('ready')) {
    state.phase = 'intake'; state.initialCall = 'open';
    record(state, 'Intake opened', 'Reporting agent', 'Simulated initial call. CRM context is still locked.');
  } else if (action === 'confirm_identity' && ['intake', 'callback_identity'].includes(state.phase)) {
    if (String(value).trim().toUpperCase() !== DEMO_CODE) {
      state.error = 'That does not match the fixture code. Use DEMO-484. CRM access has not changed.';
      return state;
    }
    if (at('intake')) {
      state.identityConfirmed = true; state.phase = 'identity_confirmed';
      record(state, 'Demo identity confirmed', 'Reporting agent', 'Fixture code matched. CRM context has not loaded yet.');
    } else {
      state.callback.identityConfirmed = true; state.phase = 'callback_connected';
      record(state, 'Callback identity confirmed', fixture.specialist, 'Demo profile loaded again before the specialist explains the finding.');
    }
  } else if (action === 'load_context' && at('identity_confirmed') && state.identityConfirmed) {
    state.context = fixtureContext(state.scenario); state.phase = 'context_ready';
    record(state, 'CRM context available', 'CRM fixture', 'The reporting agent and decision step receive the same profile, case history, queued work and available solution.');
  } else if (action === 'decide' && at('context_ready') && state.context) {
    if (state.context.solution) {
      state.phase = 'solution_proposed';
      record(state, 'Existing solution offered', 'Reporting agent', `${state.context.solution} Source: ${state.context.source}. Resolution is not confirmed.`);
    } else queueTask(state, fixture);
  } else if (action === 'solution_failed' && at('solution_proposed')) {
    state.context.solution = null;
    state.context.source = 'Caller says the existing solution did not resolve this occurrence.';
    record(state, 'Existing solution did not resolve this case', 'Caller', 'The old repair remains history; this case stays open.');
    queueTask(state, fixture);
  } else if (action === 'start_work' && at('queued')) {
    state.phase = 'working'; state.task.status = 'working';
    record(state, 'Specialist working', fixture.specialist, 'The specialist has the confirmed CRM context and current issue. No result yet.');
  } else if (action === 'request_callback' && ['working', 'no_callback_result', 'callback_unanswered'].includes(state.phase)) {
    state.callback.consent = true; state.callback.status = 'requested';
    state.callback.owner = fixture.specialist; state.initialCall = 'ended';
    state.phase = state.task.status === 'result_ready' ? 'result_ready' : 'callback_requested';
    record(state, 'Callback requested', 'Caller', `Explicit fixture consent for ${fixture.specialist} to call the demo communicator. A request is not a placed call.`);
  } else if (action === 'decline_callback' && at('working')) {
    state.phase = 'no_callback'; state.initialCall = 'ended';
    record(state, 'Initial call ended without callback consent', 'Caller', 'The specialist can keep working, but cannot place a callback.');
  } else if (action === 'finish_work' && ['callback_requested', 'no_callback'].includes(state.phase)) {
    state.task.status = 'result_ready'; state.task.finding = fixture.finding;
    state.phase = state.callback.consent ? 'result_ready' : 'no_callback_result';
    record(state, 'Specialist result ready', fixture.specialist, 'The finding arrived after the initial call. The case is still open.');
  } else if (action === 'place_callback' && at('result_ready') && state.callback.consent && state.task.status === 'result_ready') {
    state.phase = 'call_placed'; state.callback.status = 'placed';
    state.callback.attempts++; state.callback.identityConfirmed = false;
    record(state, 'Call placed', fixture.specialist, `Simulated attempt ${state.callback.attempts}. Answer, identity and resolution are not confirmed.`);
  } else if (action === 'answer_callback' && at('call_placed')) {
    state.phase = 'callback_identity'; state.callback.status = 'answered';
    record(state, 'Callback answered', fixture.specialist, 'No case details are spoken until the demo identity is confirmed again.');
  } else if (action === 'no_answer' && at('call_placed')) {
    state.phase = 'callback_unanswered'; state.callback.status = 'no_answer'; state.callback.consent = false;
    record(state, 'Call placed · no answer', fixture.specialist, 'The callback is incomplete. No automatic retry; another explicit request is required.');
  } else if (action === 'confirm_resolution' && (at('solution_proposed') || (at('callback_connected') && state.callback.identityConfirmed))) {
    state.phase = 'completed'; state.caseStatus = 'completed'; state.initialCall = 'ended';
    if (state.task) { state.task.status = 'completed'; state.callback.status = 'completed'; }
    record(state, 'Completed · caller confirmed resolution', 'Caller', 'Separate fixture evidence of resolution, not inferred from a call attempt or specialist result.');
  } else return current; // Illegal, duplicate and out-of-order actions cannot advance the story.
  return state;
}

function queueTask(state, fixture) {
  state.phase = 'queued';
  state.task = {
    id: fixture.existingTaskId || `FIXTURE-${fixture.specialist.toUpperCase()}-02`,
    owner: fixture.specialist, status: 'queued', reused: Boolean(fixture.existingTaskId),
    context: structuredClone(state.context), finding: null,
  };
  state.callback.owner = fixture.specialist;
  record(state, fixture.existingTaskId ? 'Existing task reused · queued' : 'Specialist task queued', 'Decision fixture',
    `${fixture.specialist} owns the work and any consented callback. ${fixture.existingTaskId ? 'No duplicate task created.' : 'One fictional task created.'}`);
}

export const phaseLabels = {
  ready: 'Ready to rehearse', intake: 'Reporting agent intake', identity_confirmed: 'Identity confirmed · demo',
  context_ready: 'CRM context available', solution_proposed: 'Existing solution proposed', queued: 'Queued',
  working: 'Specialist working', callback_requested: 'Callback requested', result_ready: 'Callback requested · result ready',
  call_placed: 'Call placed', callback_identity: 'Call answered · confirm identity', callback_connected: 'Specialist speaking',
  callback_unanswered: 'Call placed · no answer', no_callback: 'Specialist working · no callback requested',
  no_callback_result: 'Result ready · no callback requested', completed: 'Completed · caller confirmed',
};

export function presentation(state) {
  const fixture = scenarios[state.scenario], owner = fixture.specialist;
  const actions = {
    ready: ['begin', 'Start intake'], identity_confirmed: ['load_context', 'Make CRM context available'],
    context_ready: ['decide', 'Rehearse the decision'], solution_proposed: ['confirm_resolution', 'Caller confirms it worked'],
    queued: ['start_work', `${owner} starts work`], working: ['request_callback', `Caller requests a ${owner} callback`],
    callback_requested: ['finish_work', `${owner} returns a finding`], no_callback: ['finish_work', `${owner} returns a finding`],
    result_ready: ['place_callback', `${owner} places the callback`], call_placed: ['answer_callback', 'Caller answers'],
    callback_connected: ['confirm_resolution', 'Caller confirms it worked'],
    callback_unanswered: ['request_callback', 'Caller requests another attempt'],
    no_callback_result: ['request_callback', `Caller requests a ${owner} callback`],
  };
  const alternatives = {
    solution_proposed: ['solution_failed', 'Still not working'], working: ['decline_callback', 'End without a callback'],
    call_placed: ['no_answer', 'No answer'],
  };
  const captions = {
    ready: 'Hailing frequencies open.', intake: 'Please state your name and demo authorization code.',
    identity_confirmed: 'Demo profile loaded. Now I can request your case context.',
    context_ready: `You reported: “${fixture.issue}” I’ll check your case history.`,
    solution_proposed: state.context?.solution,
    queued: `${owner} has your issue in the queue.`,
    working: `${owner} is checking your issue. Would you like them to call you back?`,
    callback_requested: `${owner} will call you back with the finding. Your initial call has ended.`,
    result_ready: `${owner} has a finding. The requested callback has not been placed yet.`,
    call_placed: `${owner} placed a callback attempt. We do not know the outcome yet.`,
    callback_identity: `This is ${owner}. Please confirm your demo authorization code before we discuss the case.`,
    callback_connected: state.task?.finding,
    callback_unanswered: 'No answer. Your case remains open and the callback is incomplete.',
    no_callback: 'Your call has ended. The specialist is still working; no callback was requested.',
    no_callback_result: 'The finding is saved in this rehearsal. No callback was requested or placed.',
    completed: 'You confirmed the issue is resolved. This rehearsal case is complete.',
  };
  return {
    label: phaseLabels[state.phase], caption: captions[state.phase], primary: actions[state.phase], secondary: alternatives[state.phase],
    speaker: ['callback_identity', 'callback_connected'].includes(state.phase) ? `${owner} specialist · simulated speech`
      : ['ready', 'intake', 'identity_confirmed', 'context_ready', 'solution_proposed', 'queued', 'working'].includes(state.phase)
        ? 'Reporting agent · simulated speech' : 'Case desk · fixture update',
    identityForm: ['intake', 'callback_identity'].includes(state.phase),
  };
}
