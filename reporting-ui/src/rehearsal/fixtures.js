// Invented presentation data only. These are not CRM records or API payloads.
export const DEMO_CODE = 'DEMO-484';
const crew = { name: 'Commander Avery Chen', ship: 'USS Wayfinder', department: 'Operations', preference: 'Spoken troubleshooting' };

export const scenarios = {
  solution: {
    label: 'Use an existing solution', caseId: 'FIXTURE-042', specialist: 'Maintenance',
    issue: 'My replicator is making cold coffee.', equipment: 'RPL-2400 · Deck 7 mess hall',
    history: 'The same symptom was resolved in fictional case FIXTURE-019.',
    queue: 'No pending specialist work for this issue.',
    solution: 'Select the saved hot-drink profile, then make a test cup.',
    source: 'FIXTURE-019 · caller-confirmed repair in the invented history',
    finding: 'The saved drink profile needs to be restored. Try the alternate profile and check the next cup.',
  },
  it: {
    label: 'IT owns the callback', caseId: 'FIXTURE-031', specialist: 'IT',
    issue: 'The stellar survey report will not open.', equipment: 'Science terminal · Deck 4 lab',
    history: 'The caller already reported this issue in FIXTURE-031.',
    queue: 'One matching IT task is queued. Reuse it; do not add another.',
    existingTaskId: 'FIXTURE-IT-01', solution: null,
    source: 'No usable solution in the invented case history.',
    finding: 'The fictional report link is stale. Open the survey from the current mission index and confirm it loads.',
  },
  maintenance: {
    label: 'Maintenance owns the callback', caseId: 'FIXTURE-043', specialist: 'Maintenance',
    issue: 'The replicator stops halfway through every order.', equipment: 'RPL-2400 · Deck 7 mess hall',
    history: 'A previous cold-coffee repair does not match this new symptom.',
    queue: 'No matching work is queued. Create one fictional Maintenance task.',
    solution: null, source: 'No usable solution for the current symptom.',
    finding: 'A fictional diagnostic identified an interrupted order profile. Restore the saved profile and confirm a test order finishes.',
  },
};

export function fixtureContext(id) {
  const fixture = scenarios[id];
  return structuredClone({
    crew, caseId: fixture.caseId, issue: fixture.issue, equipment: fixture.equipment,
    history: fixture.history, queue: fixture.queue,
    solution: fixture.solution, source: fixture.source,
  });
}
