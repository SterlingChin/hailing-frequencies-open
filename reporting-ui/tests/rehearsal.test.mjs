import test from 'node:test';
import assert from 'node:assert/strict';
import { createRehearsal, phaseLabels, presentation, transition } from '../src/rehearsal/state.js';
import { DEMO_CODE, scenarios } from '../src/rehearsal/fixtures.js';

function advance(state, ...actions) {
  return actions.reduce((current, action) => transition(current, action, action === 'confirm_identity' ? DEMO_CODE : undefined), state);
}
function context(scenario) {
  return advance(createRehearsal(scenario), 'begin', 'confirm_identity', 'load_context');
}
function queued(scenario) { return transition(context(scenario), 'decide'); }
function placed(scenario) {
  return advance(queued(scenario), 'start_work', 'request_callback', 'finish_work', 'place_callback');
}

test('identity gates CRM context; invalid identity and out-of-order actions reveal nothing', () => {
  let state = createRehearsal();
  for (const action of ['load_context', 'decide', 'confirm_identity', 'place_callback', 'confirm_resolution']) {
    assert.strictEqual(transition(state, action, DEMO_CODE), state);
  }
  state = transition(state, 'begin');
  state = transition(state, 'confirm_identity', 'wrong');
  assert.match(state.error, /does not match/);
  assert.equal(state.context, null);
  assert.equal(state.identityConfirmed, false);
  assert.strictEqual(transition(state, 'load_context'), state);
  state = transition(state, 'confirm_identity', ' demo-484 ');
  assert.equal(state.phase, 'identity_confirmed');
  assert.equal(state.context, null, 'confirmed identity and CRM availability are separate events');
  state = transition(state, 'load_context');
  assert.equal(state.context.crew.name, 'Commander Avery Chen');
  assert.equal(state.error, '');
  assert.ok(!JSON.stringify(state.context).includes(DEMO_CODE));
});

test('existing solution is proposed, not resolved, until the caller confirms', () => {
  const proposed = queued('solution');
  assert.equal(proposed.phase, 'solution_proposed');
  assert.equal(proposed.caseStatus, 'open');
  assert.equal(proposed.task, null);
  assert.equal(proposed.callback.status, 'not_requested');
  assert.match(presentation(proposed).caption, /test cup/);
  const completed = transition(proposed, 'confirm_resolution');
  assert.equal(completed.caseStatus, 'completed');
  assert.equal(completed.callback.attempts, 0);
  assert.equal(completed.task, null);
  assert.match(completed.timeline.at(-1).detail, /not inferred/);
});

test('unsuccessful reused solution hands off the current context to Maintenance', () => {
  const state = transition(queued('solution'), 'solution_failed');
  assert.equal(state.phase, 'queued');
  assert.equal(state.task.owner, 'Maintenance');
  assert.equal(state.caseStatus, 'open');
  assert.equal(state.task.context.solution, null);
  assert.match(state.task.context.source, /did not resolve/);
});

for (const scenario of ['it', 'maintenance']) {
  test(`${scenario}: queued → working → callback requested → placed → identity → completed are distinct`, () => {
    let state = queued(scenario);
    assert.equal(state.phase, 'queued');
    assert.equal(state.task.reused, scenario === 'it');
    assert.deepEqual(state.task.context, state.context);
    assert.notStrictEqual(state.task.context, state.context);
    assert.strictEqual(transition(state, 'decide'), state, 'duplicate decision cannot create another task');
    assert.strictEqual(transition(state, 'place_callback'), state);
    state = transition(state, 'start_work');
    assert.equal(state.phase, 'working');
    assert.equal(state.callback.status, 'not_requested');
    state = transition(state, 'request_callback');
    assert.equal(state.phase, 'callback_requested');
    assert.equal(state.task.status, 'working');
    assert.equal(state.initialCall, 'ended');
    assert.equal(state.callback.owner, scenarios[scenario].specialist);
    assert.equal(state.callback.attempts, 0);
    assert.strictEqual(transition(state, 'place_callback'), state, 'cannot call before the result');
    state = transition(state, 'finish_work');
    assert.equal(state.task.status, 'result_ready');
    assert.equal(state.callback.status, 'requested');
    assert.equal(state.caseStatus, 'open');
    assert.strictEqual(transition(state, 'confirm_resolution'), state);
    state = transition(state, 'place_callback');
    assert.equal(state.phase, 'call_placed');
    assert.equal(state.callback.attempts, 1);
    assert.equal(state.callback.status, 'placed');
    assert.equal(state.caseStatus, 'open');
    assert.match(presentation(state).caption, /do not know the outcome/);
    assert.strictEqual(transition(state, 'place_callback'), state, 'no duplicate call attempt');
    assert.strictEqual(transition(state, 'confirm_resolution'), state, 'attempt does not complete case');
    state = transition(state, 'answer_callback');
    assert.equal(state.callback.identityConfirmed, false);
    assert.strictEqual(transition(state, 'confirm_resolution'), state, 'answer is not resolution');
    assert.ok(!presentation(state).caption.includes(state.task.finding));
    state = transition(state, 'confirm_identity', 'wrong');
    assert.equal(state.phase, 'callback_identity');
    state = transition(state, 'confirm_identity', DEMO_CODE);
    assert.equal(state.phase, 'callback_connected');
    assert.match(presentation(state).speaker, new RegExp(`${scenarios[scenario].specialist} specialist`));
    assert.equal(presentation(state).caption, state.task.finding);
    state = transition(state, 'confirm_resolution');
    assert.equal(state.caseStatus, 'completed');
    assert.equal(state.callback.status, 'completed');
    assert.equal(state.task.status, 'completed');
    for (const action of ['no_answer', 'place_callback', 'request_callback', 'confirm_resolution']) {
      assert.strictEqual(transition(state, action), state, 'late events cannot undo completion');
    }
    assert.equal(state.timeline.filter(event => event.title === 'Call placed').length, 1);
  });
}

test('no answer preserves the case and requires another explicit request before a retry', () => {
  let state = transition(placed('it'), 'no_answer');
  assert.equal(state.caseStatus, 'open');
  assert.equal(state.callback.status, 'no_answer');
  assert.equal(state.callback.consent, false);
  assert.equal(state.task.status, 'result_ready');
  assert.strictEqual(transition(state, 'place_callback'), state);
  assert.strictEqual(transition(state, 'confirm_resolution'), state);
  assert.equal(state.timeline.some(event => event.phase === 'completed'), false);
  state = advance(state, 'request_callback', 'place_callback');
  assert.equal(state.callback.attempts, 2);
  assert.equal(state.caseStatus, 'open');
  assert.equal(state.timeline.filter(event => event.title === 'Callback requested').length, 2);
});

test('a finding or preference without callback consent cannot place a call', () => {
  let state = advance(queued('maintenance'), 'start_work', 'decline_callback', 'finish_work');
  assert.equal(state.phase, 'no_callback_result');
  assert.equal(state.task.status, 'result_ready');
  assert.equal(state.callback.status, 'not_requested');
  assert.equal(state.callback.attempts, 0);
  assert.equal(state.caseStatus, 'open');
  assert.strictEqual(transition(state, 'place_callback'), state);
  state = advance(state, 'request_callback', 'place_callback');
  assert.equal(state.callback.attempts, 1);
});

test('reset isolates identities, context, tasks, attempts and timeline between stories', () => {
  const prior = placed('it');
  const reset = createRehearsal('maintenance');
  assert.equal(prior.callback.attempts, 1);
  assert.equal(reset.identityConfirmed, false);
  assert.equal(reset.context, null);
  assert.equal(reset.task, null);
  assert.equal(reset.callback.owner, null);
  assert.equal(reset.callback.attempts, 0);
  assert.deepEqual(reset.timeline, []);
  assert.throws(() => createRehearsal('unknown'), /Unknown/);
});

test('every supported phase has a caption and an honest label', () => {
  for (const phase of Object.keys(phaseLabels)) {
    const state = placed('maintenance');
    state.phase = phase;
    state.context.solution = 'Fixture solution';
    const view = presentation(state);
    assert.equal(typeof view.caption, 'string', phase);
    assert.ok(view.label.length, phase);
  }
});
