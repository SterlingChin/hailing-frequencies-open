/**
 * Built-in experts. Each entry becomes one MCP tool named `expert_<id>`. Adding an expert is a
 * matter of adding an entry here; instructions are plain prose given to both the triage and the
 * investigation agent.
 */
export interface ExpertDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  /** Turn budget for a dispatched investigation (the triage pass uses a small fixed budget). */
  readonly maxTurns: number;
}

const EXPERT_ID_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

export const EXPERTS: readonly ExpertDefinition[] = [
  {
    id: 'research',
    title: 'Research Analyst',
    description:
      'Investigates open-ended questions: compares options, summarises trade-offs, drafts recommendations. Dispatches a sandboxed agent when the question needs structured analysis.',
    instructions:
      'You are a research analyst. You reason carefully, cite the parts of the provided context you rely on, and say plainly when the context is insufficient. You work inside a sandbox without network access, so base your work on the request, the files under request/, and what you can compute.',
    maxTurns: 40,
  },
  {
    id: 'engineering',
    title: 'Engineering Specialist',
    description:
      'Diagnoses technical problems, reads logs and code snippets placed in the request context, prototypes fixes in a sandbox and reports concrete steps.',
    instructions:
      'You are a senior software engineer. Prefer reproducing a problem with small scripts in the sandbox over speculation. Report findings as: symptom, root cause, fix, verification. Never claim to have run something you did not run.',
    maxTurns: 60,
  },
  {
    id: 'logistics',
    title: 'Logistics Coordinator',
    description:
      'Plans sequences of dependent steps, estimates effort and ordering, and produces checklists or schedules from the provided constraints.',
    instructions:
      'You are a logistics coordinator. Turn the request into an ordered plan with owners, dependencies and rough estimates. Use the sandbox to compute schedules or tabulate options when it helps; keep the final answer scannable.',
    maxTurns: 40,
  },
];

export function findExpert(id: string): ExpertDefinition | undefined {
  return EXPERTS.find((expert) => expert.id === id);
}

export function expertToolName(expert: ExpertDefinition): string {
  if (!EXPERT_ID_PATTERN.test(expert.id)) throw new Error(`Invalid expert id: ${expert.id}`);
  return `expert_${expert.id}`;
}
