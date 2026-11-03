// The Decisions API is a classifier, not a reasoner: it answers fixed questions
// about one shared input. These are the base routing questions; trusted reporter
// intake also supplies an issue-selection question from the caller’s CRM records.
// Shapes follow .sannr/stacks/openai/openapi.yaml (POST /decisions, gpt-6-luna).

export const DECISIONS_MODEL = 'gpt-6-luna';
export const ROUTES = Object.freeze(['it', 'maintenance', 'none']);
export const URGENCY_LEVELS = Object.freeze(['routine', 'elevated', 'urgent', 'critical']);
// Follow-up questions should require strong evidence of a routing blocker,
// rather than uncertainty that a specialist can investigate after handoff.
export const THRESHOLDS = Object.freeze({ resolvableNow: 0.6, needsMoreDetails: 0.75, minimumRouteConfidence: 0.5, minimumIssueConfidence: 0.4 });

export const QUESTIONS = Object.freeze([
  { type: 'choice', name: 'route',
    instructions: 'Which specialist desk should handle this request? Choose "none" when the stored answer for the caller-confirmed case and current symptom revision lets the reporting agent help on this call. Expert is the shared agent entry point, not a separate destination. A pending task alone is not a solution.',
    choices: [
      { value: 'it', description: 'Software, accounts, permissions, reports, connectivity, or access to a system or area needs IT support.' },
      { value: 'maintenance', description: 'Physical or replicated equipment is broken, degraded, or producing wrong output.' },
      { value: 'none', description: 'No specialist is needed.' },
    ] },
  { type: 'predicate', name: 'resolvable_now',
    instructions: 'The reporting agent can answer this request now using the stored answer for the selected case and current symptom revision, without new specialist work. Do not count pending, failed, obsolete, or caller-rejected findings as solutions; a proposed finding is not proof of a confirmed fix.' },
  { type: 'predicate', name: 'needs_more_details',
    instructions: 'A concrete unanswered fact prevents identifying the affected issue, choosing IT or Maintenance, or using a stored answer. Use all provided CRM context and conversation history, including answers from earlier turns. A clear symptom and affected system, plus location when needed to identify it, are enough for specialist handoff. For example, a malfunctioning warp drive in the engine bay is ready for Maintenance to investigate; the reporter does not need to diagnose its cause first. Missing root cause, exact error text, warning lights, sounds, or prior troubleshooting do not by themselves block routing. Do not ask again for facts already supplied or troubleshooting the caller says they cannot provide. Score true only for information essential to the next action, not information the expert could gather after handoff.' },
  { type: 'score', name: 'urgency',
    instructions: 'Rate urgency from the stated impact on current duties, deadlines, safety and mission operations. Do not infer a deadline or blocked duty from rank, department or an inaccessible report alone. If impact is not stated, choose routine.',
    levels: [
      { label: 'routine', description: 'Inconvenient; can wait a day.' },
      { label: 'elevated', description: 'Blocks part of the caller\'s duties today.' },
      { label: 'urgent', description: 'Blocks a duty with a deadline this shift.' },
      { label: 'critical', description: 'Safety, security, or mission impact right now.' },
    ] },
]);

export function buildDecisionRequest({ input, safetyIdentifier = null, model = DECISIONS_MODEL, questions = QUESTIONS }) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('decision_input_required');
  if (safetyIdentifier !== null && (typeof safetyIdentifier !== 'string' || safetyIdentifier.length > 128)) throw new Error('invalid_safety_identifier');
  const request = { model, input, questions: questions.map(q => ({ ...q })) };
  if (safetyIdentifier) request.safety_identifier = safetyIdentifier;
  return request;
}

const number = v => typeof v === 'number' && Number.isFinite(v);
const probability = v => number(v) && v >= 0 && v <= 1;
export function validAnswerSet(answers, questions = QUESTIONS) {
  return Array.isArray(answers) && answers.length === questions.length
    && questions.every(q => {
      const matches = answers.filter(a => a?.name === q.name);
      if (matches.length !== 1) return false;
      const a = matches[0];
      if (a.type === 'refusal') return true;
      if (a.type !== q.type) return false;
      if (q.type === 'predicate') return probability(a.probability);
      if (q.type === 'choice') return q.choices.some(option => option.value === a.choice) && probability(a.confidence);
      return number(a.score) && a.score >= 0 && a.score <= 3
        && Array.isArray(a.probabilities) && a.probabilities.length > 0
        && a.probabilities.every(p => URGENCY_LEVELS.includes(p?.label) && probability(p.probability));
    });
}
function byName(answers) {
  const map = new Map();
  for (const a of answers) if (a && typeof a === 'object' && typeof a.name === 'string') map.set(a.name, a);
  return map;
}

/**
 * Turns raw answers into one of four outcomes the reply step acts on:
 * needs_more_details | solution | queue | undecided. Thresholds are explicit so
 * the whiteboard can argue about numbers, not code.
 */
export function interpretAnswers(answers) {
  if (!Array.isArray(answers)) return { outcome: 'undecided', reason: 'invalid_answers', refusals: [] };
  const map = byName(answers);
  const refusals = answers.filter(a => a?.type === 'refusal').map(a => a.name ?? null);
  if (!validAnswerSet(answers)) return { outcome: 'undecided', reason: 'incomplete_answers', refusals };
  if (refusals.length) return { outcome: 'undecided', reason: 'refused', refusals };
  const route = map.get('route'), resolvable = map.get('resolvable_now'), details = map.get('needs_more_details'), urgency = map.get('urgency');
  const result = {
    route: route?.type === 'choice' && ROUTES.includes(route.choice) ? route.choice : null,
    routeConfidence: route?.type === 'choice' && number(route.confidence) ? route.confidence : null,
    resolvableNow: resolvable?.type === 'predicate' && number(resolvable.probability) ? resolvable.probability : null,
    needsMoreDetails: details?.type === 'predicate' && number(details.probability) ? details.probability : null,
    urgency: urgency?.type === 'score' && number(urgency.score) ? urgency.score : null,
    urgencyLabel: null, refusals,
  };
  if (urgency?.type === 'score' && Array.isArray(urgency.probabilities) && urgency.probabilities.length) {
    const top = [...urgency.probabilities].sort((a, b) => b.probability - a.probability)[0];
    result.urgencyLabel = URGENCY_LEVELS.includes(top?.label) ? top.label : null;
  }
  if (result.needsMoreDetails === null || result.resolvableNow === null || result.route === null) {
    return { ...result, outcome: 'undecided', reason: refusals.length ? 'refused' : 'incomplete_answers' };
  }
  // Desk confidence is the handoff gate. Missing details and CRM matching are
  // work the expert can continue; neither can veto a valid confident route.
  if (result.route !== 'none' && result.routeConfidence > THRESHOLDS.minimumRouteConfidence) {
    return { ...result, outcome: 'queue', reason: `route_${result.route}` };
  }
  if (result.needsMoreDetails >= THRESHOLDS.needsMoreDetails) return { ...result, outcome: 'needs_more_details', reason: 'details_missing' };
  if (result.resolvableNow >= THRESHOLDS.resolvableNow) {
    return { ...result, outcome: 'solution', reason: 'resolvable_on_call' };
  }
  return { ...result, outcome: 'undecided', reason: 'low_route_confidence' };
}
