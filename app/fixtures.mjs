import { lookupRepair } from '../voice/config.mjs';
import { lookupParts } from '../specialists/catalog.mjs';

const repair = lookupRepair({ equipment_model: 'RPL-2400', symptom: 'coffee cold' });
const part = lookupParts({ equipment_model: 'RPL-2400' });
export const REPAIR_SUMMARY = `HF-042 — fictional repair summary. Possible cause: ${repair.diagnosis} Steps: ${repair.steps.join(' ')}`;
const clone = value => structuredClone(value);
const initial = {
  source: 'fixture', connection: 'connecting', speaker: { name: 'Caller', role: 'caller', state: 'Opening a channel' },
  caption: 'Open a channel to Federation Customer Service.',
  crew: null, case: null, tasks: [], message: { status: 'not_requested', text: 'A preference is not a request. No text has been requested.' },
  nextStep: null, timeline: [],
};
const loadedCrew = { name: 'Commander Avery Chen', ship: 'USS Wayfinder', equipment: 'Replicator RPL-2400 · Deck 7', state: 'Demo profile loaded', history: 'Thermal calibration completed two weeks ago', preference: 'Spoken troubleshooting · repair steps by SMS' };

export function fixtureFrames(scenario = 'repair') {
  if (!['repair', 'returning', 'failure', 'revised'].includes(scenario)) return null;
  const frames = [];
  let state = clone(initial);
  function beat(patch, actor, text, kind = 'voice') {
    const index = frames.length;
    state = { ...clone(state), ...patch };
    state.timeline.push({ id: `${scenario}-${index}`, time: `${String(Math.floor(index * 8 / 60)).padStart(2, '0')}:${String(index * 8 % 60).padStart(2, '0')}`, kind, actor, text });
    frames.push(clone(state));
  }
  beat({}, 'Caller', 'Open a channel to Federation Customer Service.', 'connection');
  beat({ connection: 'connected', speaker: { name: 'Support officer', role: 'agent', state: 'Agent speaking' }, caption: 'Channel open.' }, 'Support officer', 'Channel open.');
  beat({ crew: loadedCrew, caption: scenario === 'returning' ? 'Is this about your replicator case from last week?' : 'I have your RPL-2400 on Deck 7. What is it doing?' }, 'Profile', 'Demo profile loaded using the fictional authorization phrase.', 'case');
  if (scenario === 'returning') {
    beat({ case: { id: 'HF-038', status: 'open', symptom: 'Coffee and tea arrived cold', revision: 1, diagnosisStatus: 'not_fixed' }, caption: 'Yes, the replicator case.', speaker: { name: 'Avery Chen', role: 'caller', state: 'Caller speaking' } }, 'Avery Chen', 'Caller confirmed the earlier case.', 'case');
    beat({ caption: 'The thermal regulator shipped by Subspace courier. It is due tomorrow.', speaker: { name: 'Support officer', role: 'agent', state: 'Agent speaking' }, nextStep: { label: 'Await the replacement', text: 'Shipped via Subspace courier · ETA tomorrow. The earlier recalibration did not fix the issue.', source: 'Invented returning-case history', status: 'Previous repair not fixed' }, tasks: [{ id: 'returning-parts', specialist: 'logistics', assignment: 'Review the earlier part order', status: 'result_ready', finding: 'Fictional order record: shipped via Subspace courier, due tomorrow.' }] }, 'Logistics', 'Stored fictional shipment history reviewed; no new order.', 'task');
    beat({ connection: 'ended', speaker: { name: 'Support officer', role: 'agent', state: 'Call ended' }, caption: 'Your case stays open. We will pick up here next time.' }, 'Connection', 'Fixture call ended; case remains open.', 'connection');
    return frames;
  }
  beat({ case: { id: 'HF-042', status: 'open', symptom: 'Coffee arrives cold; other drinks not yet checked', revision: 1, diagnosisStatus: 'none' }, caption: 'My replicator is making cold coffee.', speaker: { name: 'Avery Chen', role: 'caller', state: 'Caller speaking' } }, 'Avery Chen', 'Opened a case for cold coffee.', 'case');
  beat({ caption: 'Engineering is checking the thermal calibration procedure.', speaker: { name: 'Support officer', role: 'agent', state: 'Agent speaking' }, tasks: [{ id: 'engineering-1', specialist: 'engineering', assignment: 'Check thermal calibration for RPL-2400', status: 'working' }] }, 'Engineering', 'Started the fictional repair lookup.', 'task');
  if (scenario === 'revised') {
    beat({ caption: 'Actually, tea is cold too.', speaker: { name: 'Avery Chen', role: 'caller', state: 'Caller interrupted' }, case: { ...state.case, symptom: 'Coffee and tea arrive cold', revision: 2 }, tasks: [{ ...state.tasks[0], status: 'obsolete', finding: 'Earlier work was replaced after the symptom changed.' }], nextStep: { label: 'A new check is needed', text: 'The earlier result cannot become the current recommendation.', source: 'Case symptom revision 2', status: 'Awaiting new check' } }, 'Avery Chen', 'Revised the symptom. The earlier task is obsolete.', 'case');
    beat({ connection: 'ended', speaker: { name: 'Support officer', role: 'agent', state: 'Call ended' }, caption: 'The updated case is saved. A new Engineering check is needed.' }, 'Connection', 'Fixture call ended with follow-up work remaining.', 'connection');
    return frames;
  }
  beat({ tasks: [{ ...state.tasks[0], status: 'result_ready', finding: repair.diagnosis }, { id: 'logistics-1', specialist: 'logistics', assignment: 'Check a compatible thermal regulator', status: 'working' }], case: { ...state.case, diagnosisStatus: 'proposed' }, caption: 'Calibration drift is a possible cause. Let’s try a thermal calibration cycle.', nextStep: { label: 'Try a thermal calibration cycle', text: repair.steps.join(' '), source: repair.source_id, status: 'Proposed · caller has not confirmed a fix' } }, 'Engineering', 'Proposed a repair from the fictional catalog.', 'task');
  beat({ tasks: [state.tasks[0], { ...state.tasks[1], status: 'result_ready', finding: part.summary }], caption: 'A compatible regulator is available if we need it. Nothing is ordered.' }, 'Logistics', part.summary, 'task');
  beat({ caption: 'Text me the details, to the number I’m calling from.', speaker: { name: 'Avery Chen', role: 'caller', state: 'Caller speaking' }, message: { status: 'requested', destination: 'Avery’s mobile · fictional contact', text: 'Caller explicitly requested the repair summary.', summary: REPAIR_SUMMARY } }, 'Avery Chen', 'Requested the repair summary by text.', 'message');
  beat({ caption: scenario === 'failure' ? 'Delivery is not confirmed. Your repair summary is available below.' : 'SMS is unavailable in this preview. Your repair summary is available below.', speaker: { name: 'Support officer', role: 'agent', state: 'Agent speaking' }, message: { ...state.message, status: scenario === 'failure' ? 'failed' : 'unavailable', text: scenario === 'failure' ? 'Simulated failed delivery. Use the summary on screen.' : 'No SMS was sent. Use the summary on screen.' } }, 'Follow-up', scenario === 'failure' ? 'Simulated delivery failure; summary retained on screen.' : 'Fixture uses the on-screen fallback; nothing sent.', 'message');
  beat({ connection: 'ended', caption: 'Your case remains open. The repair is still proposed.', speaker: { name: 'Support officer', role: 'agent', state: 'Call ended' } }, 'Connection', 'Fixture call ended; repair summary and case remain available.', 'connection');
  return frames;
}
