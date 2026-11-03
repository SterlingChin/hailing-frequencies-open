import { createHash } from 'node:crypto';
import { buildContextBundle } from '../context/bundle.mjs';
import { interpretAnswers } from './questions.mjs';
import { createReporterDecisionStep } from './reporter-step.mjs';
import { CRMError } from '../crm/service.mjs';
import { classificationInput } from './reporting-action.mjs';
import { isNonexistentDemoShip } from '../crm/ships.mjs';

/**
 * Context → decision → saved handoff. One call per caller request. Provider failures
 * never throw: the officer gets "undecided" and continues without a promise.
 * The safety identifier is a hash of the interaction ID, never a phone number.
 */
export function createDecisionStep({ service = null, client = null }) {
  return {
    ...createReporterDecisionStep({ service, client }),
    enabled: Boolean(client?.enabled),
    async evaluate({ interactionId = null, profile = null, request, channel = 'voice' }) {
      let caseBrief = null, context = null;
      if (service && interactionId) {
        try {
          context = await service.getInteractionContext({ interactionId, request, channel });
          profile = context.profile;
          caseBrief = context.selected_case?.brief ?? null;
        } catch (error) {
          if (!(error instanceof CRMError)) throw error;
          return { outcome: 'undecided', reason: error.code, identified: false, hasSelectedCase: false, task: null, context: null };
        }
      }
      if (isNonexistentDemoShip(profile?.ship)) throw new CRMError('ship_not_found');
      const bundle = buildContextBundle({ profile, caseBrief, request, channel });
      const base = { identified: bundle.identified, hasSelectedCase: bundle.hasSelectedCase, task: null, context, solution: null, reused: false };
      if (!client?.enabled) return { ...base, outcome: 'undecided', reason: 'decisions_unavailable' };
      if (service && interactionId && !context?.selected_case) return { ...base, outcome: 'undecided', reason: 'case_required' };
      const safetyIdentifier = interactionId ? createHash('sha256').update(String(interactionId)).digest('hex').slice(0, 32) : null;
      const response = await client.decide({ input: classificationInput(context?.text ?? bundle.text), safetyIdentifier });
      if (!response.ok) return { ...base, outcome: 'undecided', reason: response.error.code };
      const decision = { ...base, ...interpretAnswers(response.answers), usage: response.usage };
      if (!['queue', 'solution'].includes(decision.outcome)) return decision;
      if (!service || !interactionId) return { ...decision, outcome: 'undecided', reason: 'queue_unavailable' };
      try {
        Object.assign(decision, await service.applyRoutingDecision({ interactionId, context, outcome: decision.outcome, specialist: decision.route,
          assignment: `${decision.urgencyLabel ?? 'routine'}: ${request.replace(/\s+/g, ' ').trim()}`.slice(0, 300) }));
      } catch (error) {
        if (!(error instanceof CRMError)) throw error;
        return { ...decision, outcome: 'undecided', reason: error.code };
      }
      return decision;
    },
  };
}
