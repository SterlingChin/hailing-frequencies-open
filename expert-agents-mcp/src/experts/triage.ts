import { z } from 'zod';
import type { Model, ModelSettings } from '@openai/agents';
import { SandboxAgent, compaction, filesystem, shell } from '@openai/agents/sandbox';
import type { ExpertDefinition } from './registry.js';

export const TRIAGE_MAX_TURNS = 4;

/**
 * Structured triage verdict. Nullable (not optional) fields keep the JSON schema strict-mode
 * friendly for the Responses API.
 */
export const TriageDecisionSchema = z.object({
  decision: z.enum(['answer_now', 'dispatch']),
  summary: z.string().describe('One sentence describing the request and what you decided.'),
  answer: z
    .string()
    .nullable()
    .describe('The complete answer when decision is answer_now; otherwise null.'),
  plan: z
    .string()
    .nullable()
    .describe('Concrete investigation plan when decision is dispatch; otherwise null.'),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

export interface ExpertInput {
  question: string;
  context?: string;
}

const TRIAGE_PROTOCOL = `
Triage protocol. You have just been handed a request. Decide quickly, within a couple of steps:
- Choose "answer_now" when you can answer confidently and completely from the request and the
  files under request/ alone. Put the full answer in "answer".
- Choose "dispatch" when a good answer needs investigation: running code, inspecting or
  transforming files in the workspace, multi-step analysis, or anything you would want to verify.
  Put a concrete, ordered plan in "plan" (what you will do and what the report will contain).
Do not start the investigation during triage. Keep "summary" to one sentence.`;

export function buildTriageAgent(
  expert: ExpertDefinition,
  model: string | Model,
  modelSettings: ModelSettings = { reasoning: { effort: 'low' } },
) {
  return new SandboxAgent({
    name: `${expert.title} (triage)`,
    model,
    modelSettings,
    instructions: `${expert.instructions}\n${TRIAGE_PROTOCOL}`,
    outputType: TriageDecisionSchema,
    capabilities: [shell(), filesystem(), compaction()],
  });
}

export function triagePrompt(input: ExpertInput): string {
  const lines = [
    'Request:',
    input.question.trim(),
    '',
    input.context
      ? 'Additional context was provided; it is also saved at request/context.md.'
      : 'No additional context was provided beyond the request text.',
    'The request text is saved at request/question.md. Write any artefacts under out/.',
  ];
  return lines.join('\n');
}
