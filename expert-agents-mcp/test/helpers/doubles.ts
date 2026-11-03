import { Runner } from '@openai/agents';
import type { Editor } from '@openai/agents';
import { Manifest } from '@openai/agents/sandbox';
import type { SandboxSession, SandboxSessionState } from '@openai/agents/sandbox';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
  modelResponder,
  scriptedSandboxSession,
} from '@openai/agents/testing';
import type { ScriptedModelInput } from '@openai/agents/testing';
import { ScriptedSandboxProvider } from '../../src/experts/scripted-sandbox.js';
import type { TriageDecision } from '../../src/experts/triage.js';
import { createExpertRuntime } from '../../src/server.js';
import type { ExpertServerDependencies, ExpertServerRuntime } from '../../src/server.js';

/** Scripted OpenAI model + sandbox doubles. No vendor traffic is possible in tests. */

export function triageStep(decision: TriageDecision): ScriptedModelInput {
  return [assistantMessage(JSON.stringify(decision))];
}

export const ANSWER_NOW: TriageDecision = {
  decision: 'answer_now',
  summary: 'Simple factual question.',
  answer: 'The replicator needs a matter-stream recalibration.',
  plan: null,
};

export const DISPATCH: TriageDecision = {
  decision: 'dispatch',
  summary: 'Needs a sandboxed investigation.',
  answer: null,
  plan: 'List the workspace, then write the report.',
};

export const SHELL_COMMAND = 'ls out/';
export const REPORT =
  'Conclusion: the pattern buffer is misaligned.\n- Ran ls out/\nCaveats: none.';

export function investigationSteps(report = REPORT): ScriptedModelInput[] {
  return [
    [functionCall('exec_command', { cmd: SHELL_COMMAND }, { callId: 'call_1' })],
    [assistantMessage(report)],
  ];
}

/** A model step that stays pending until the run's abort signal fires. */
export function hangingStep(): ScriptedModelInput {
  return modelResponder(
    (call) =>
      new Promise((_, reject) => {
        const signal = call.request.signal;
        const abort = () => reject(new DOMException('Model call aborted', 'AbortError'));
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort, { once: true });
      }),
  );
}

export function failingStep(message = 'model exploded'): ScriptedModelInput {
  return modelError(new Error(message));
}

/**
 * Minimal developer-owned sandbox session. The shell and filesystem capabilities require
 * `execCommand` and `createEditor` to exist before any tool runs, so the SDK's step-based
 * `scriptedSandboxSession` (which only exposes scripted methods) is not enough on its own.
 */
export class FakeSandboxSession implements SandboxSession {
  state: SandboxSessionState = { manifest: new Manifest(), workspaceReady: true };
  readonly commands: string[] = [];
  closed = false;
  #outputs: Record<string, string>;

  constructor(outputs: Record<string, string> = { [SHELL_COMMAND]: '' }) {
    this.#outputs = outputs;
  }

  async applyManifest(): Promise<void> {}

  async execCommand(args: { cmd: string }): Promise<string> {
    this.commands.push(args.cmd);
    const output = this.#outputs[args.cmd];
    if (output === undefined) throw new Error(`Unexpected command in fake sandbox: ${args.cmd}`);
    return output;
  }

  createEditor(): Editor {
    return {
      createFile: async () => ({ status: 'completed', output: 'created' }),
      updateFile: async () => ({ status: 'completed', output: 'updated' }),
      deleteFile: async () => ({ status: 'completed', output: 'deleted' }),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function shellSession(expectedCommand = SHELL_COMMAND, output = ''): SandboxSession {
  return new FakeSandboxSession({ [expectedCommand]: output });
}

/** The SDK's own scripted session, kept for parity with the official testing guide. */
export function scriptedShellSession(expectedCommand = SHELL_COMMAND, output = ''): SandboxSession {
  return scriptedSandboxSession([
    { method: 'execCommand', match: ({ cmd }) => cmd === expectedCommand, result: output },
  ]);
}

export interface TestRuntime {
  runtime: ExpertServerRuntime;
  sandbox: ScriptedSandboxProvider;
  model: ScriptedModel;
}

export function buildTestRuntime(
  steps: ScriptedModelInput[],
  options: Partial<ExpertServerDependencies> & { sessions?: () => SandboxSession } = {},
): TestRuntime {
  const model = new ScriptedModel(steps);
  const sandbox = new ScriptedSandboxProvider(options.sessions ?? (() => new FakeSandboxSession()));
  const runtime = createExpertRuntime({
    sandbox,
    runner: new Runner({ tracingDisabled: true }),
    model,
    taskTtlMs: 60_000,
    pollIntervalMs: 10,
    dispatchTtlMs: 60_000,
    maxConcurrent: 3,
    ...options,
  });
  return { runtime, sandbox, model };
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
