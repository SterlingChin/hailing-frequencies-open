import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction, confirmIdentity, captureReport, editReport } from '../server/reporting.mjs';

const phrase = 'Authorization, Chen, Avery. Alpha seven, Bravo nine, Echo two';
test('identity compares the demo phrase and normalized spoken digits', () => {
  for (const code of [phrase, 'CHEN-AVERY-A7B9E2', 'Authorization Chen Avery Alpha 7 Bravo 9 Echo 2']) {
    const state = createInteraction();
    assert.equal(confirmIdentity(state, code).ok, true);
    assert.equal(state.authorized, true);
  }
});
test('the previous authorization phrase is rejected', () => {
  assert.equal(confirmIdentity(createInteraction(), 'Authorization, Chen, Avery, Alpha four eight four Beta seven').ok, false);
});

test('wrong identity locks after three attempts, including a correct fourth', () => {
  const state = createInteraction();
  for (let i = 0; i < 3; i++) assert.equal(confirmIdentity(state, 'Picard Alpha 1').ok, false);
  assert.equal(confirmIdentity(state, phrase).ok, false);
  assert.equal(state.authorized, false);
});
test('capture is gated by server identity and never sends externally', () => {
  const state = createInteraction();
  assert.equal(captureReport(state, { issue: 'The hatch is stuck.' }).ok, false);
  confirmIdentity(state, phrase);
  assert.equal(captureReport(state, { issue: '   ' }).ok, false);
  const result = captureReport(state, { issue: 'The hatch is stuck.', location: 'Deck 7' });
  assert.equal(result.ok, true);
  assert.equal(result.report.issue, 'The hatch is stuck.');
  assert.equal(result.report.delivery, 'not_sent');
  assert.equal(result.report.crew.name, 'Avery Chen');
  assert.equal(editReport(state, { issue: 'The hatch is intermittently stuck.', location: 'Deck 8' }).report.location, 'Deck 8');
});
test('separate interactions cannot use another interaction’s authorization or report', () => {
  const one = createInteraction(), two = createInteraction();
  confirmIdentity(one, phrase);
  captureReport(one, { issue: 'Broken replicator' });
  assert.equal(captureReport(two, { issue: 'Broken replicator' }).ok, false);
  assert.equal(two.report, null);
});

test('an owned recap remains editable after voice authorization expires', () => {
  const state = createInteraction(); confirmIdentity(state, phrase);
  const original = captureReport(state, { issue: 'Broken hatch', location: 'Deck 7' }).report;
  state.authorized = false;
  assert.equal(captureReport(state, { issue: 'New voice content' }).ok, false);
  const edited = editReport(state, { issue: 'Hatch sticks intermittently', location: 'Deck 7' });
  assert.equal(edited.ok, true); assert.equal(edited.report.id, original.id);
  assert.equal(edited.report.crew, original.crew); assert.equal(edited.report.reviewed, true);
});
