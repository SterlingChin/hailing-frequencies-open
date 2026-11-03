import type { Model, ModelSettings } from '@openai/agents';
import { SandboxAgent, compaction, filesystem, shell } from '@openai/agents/sandbox';
import type { ExpertDefinition } from './registry.js';

const INVESTIGATION_PROTOCOL = `
Investigation protocol. You decided this request needs real work. Follow your plan, use the
sandbox to verify what you claim, and finish with a self-contained report in plain text:
1. One-paragraph conclusion that answers the request.
2. What you did and what you found (short bullets).
3. Open questions or caveats.
Do not ask the requester questions; make reasonable assumptions and state them.`;

export function buildInvestigatorAgent(
  expert: ExpertDefinition,
  model: string | Model,
  modelSettings: ModelSettings = { reasoning: { effort: 'medium' } },
) {
  return new SandboxAgent({
    name: expert.title,
    model,
    modelSettings,
    instructions: `${expert.instructions}\n${INVESTIGATION_PROTOCOL}`,
    capabilities: [shell(), filesystem(), compaction()],
  });
}

export function investigationPrompt(plan: string): string {
  return `Proceed with the investigation now. Your triage plan was:\n${plan.trim()}`;
}
