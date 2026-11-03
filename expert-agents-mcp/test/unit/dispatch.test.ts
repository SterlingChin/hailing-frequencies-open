import { afterEach, describe, expect, it } from 'vitest';
import { EXPERTS, findExpert } from '../../src/experts/registry.js';
import type { ProgressSink } from '../../src/experts/dispatch.js';
import {
  ANSWER_NOW,
  DISPATCH,
  REPORT,
  SHELL_COMMAND,
  buildTestRuntime,
  failingStep,
  hangingStep,
  investigationSteps,
  shellSession,
  triageStep,
  waitUntil,
} from '../helpers/doubles.js';
import type { TestRuntime } from '../helpers/doubles.js';

const research = findExpert('research')!;
const input = {
  question: 'Why does replicator RPL-2400 produce cold tea?',
  context: 'case HF-042',
};

function sink(signal = new AbortController().signal): ProgressSink & { messages: string[] } {
  const messages: string[] = [];
  return {
    signal,
    messages,
    status: async (message) => {
      messages.push(message);
    },
  };
}

describe('ExpertDispatchService', () => {
  const runtimes: TestRuntime[] = [];
  afterEach(async () => {
    for (const { runtime } of runtimes.splice(0)) await runtime.dispose();
  });
  function setup(...args: Parameters<typeof buildTestRuntime>): TestRuntime {
    const built = buildTestRuntime(...args);
    runtimes.push(built);
    return built;
  }

  it('answers directly when triage says answer_now and closes the sandbox', async () => {
    const { runtime, sandbox, model } = setup([triageStep(ANSWER_NOW)]);
    const progress = sink();
    const outcome = await runtime.dispatch.consult(research, input, progress);

    expect(outcome).toEqual({
      kind: 'answered',
      expertId: 'research',
      summary: ANSWER_NOW.summary,
      answer: ANSWER_NOW.answer,
    });
    expect(progress.messages).toEqual([
      'Starting sandbox for Research Analyst…',
      'Research Analyst started; triaging the request…',
    ]);
    expect(sandbox.created).toHaveLength(1);
    expect(sandbox.closed).toHaveLength(1);
    model.assertComplete();
  });

  it('dispatches a background investigation that streams status and ends with a report', async () => {
    const { runtime, sandbox, model } = setup([triageStep(DISPATCH), ...investigationSteps()], {
      sessions: () => shellSession(),
    });
    const outcome = await runtime.dispatch.consult(research, input, sink());
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.plan).toBe(DISPATCH.plan);

    const final = await runtime.dispatch.waitFor(outcome.dispatchId);
    expect(final).toMatchObject({ status: 'completed', report: REPORT, expertId: 'research' });
    expect(final?.statusLog).toEqual([
      'Investigation started',
      `Running exec_command: ${SHELL_COMMAND}`,
      'Report ready',
    ]);
    expect(final?.finishedAt).toBeDefined();
    expect(sandbox.closed).toHaveLength(1);
    expect(runtime.dispatch.activeCount).toBe(0);
    model.assertComplete();
  });

  it('cancels a running investigation and tears the sandbox down', async () => {
    const { runtime, sandbox } = setup([triageStep(DISPATCH), hangingStep()]);
    const outcome = await runtime.dispatch.consult(research, input, sink());
    if (outcome.kind !== 'dispatched') throw new Error('expected dispatch');
    expect(runtime.dispatch.status(outcome.dispatchId)?.status).toBe('working');

    expect(await runtime.dispatch.cancel(outcome.dispatchId)).toBe(true);
    expect(runtime.dispatch.status(outcome.dispatchId)).toMatchObject({
      status: 'cancelled',
      latestStatus: 'Cancelled',
    });
    expect(sandbox.closed).toHaveLength(1);
    expect(await runtime.dispatch.cancel('missing')).toBe(false);
  });

  it('marks the job failed with a short message when the investigation errors', async () => {
    const { runtime, sandbox } = setup([triageStep(DISPATCH), failingStep('model exploded')]);
    const outcome = await runtime.dispatch.consult(research, input, sink());
    if (outcome.kind !== 'dispatched') throw new Error('expected dispatch');
    const final = await runtime.dispatch.waitFor(outcome.dispatchId);
    expect(final).toMatchObject({ status: 'failed', error: 'model exploded' });
    expect(final?.report).toBeUndefined();
    expect(sandbox.closed).toHaveLength(1);
  });

  it('reports capacity instead of dispatching when every slot is busy', async () => {
    const { runtime, sandbox } = setup(
      [triageStep(DISPATCH), hangingStep(), triageStep(DISPATCH)],
      {
        maxConcurrent: 1,
      },
    );
    const first = await runtime.dispatch.consult(research, input, sink());
    expect(first.kind).toBe('dispatched');
    const second = await runtime.dispatch.consult(research, input, sink());
    expect(second).toMatchObject({ kind: 'capacity', plan: DISPATCH.plan });
    expect(sandbox.created).toHaveLength(2);
    expect(sandbox.closed).toHaveLength(1);
  });

  it('aborts triage when the caller cancels and closes the sandbox', async () => {
    const { runtime, sandbox } = setup([hangingStep()]);
    const controller = new AbortController();
    const pending = runtime.dispatch.consult(research, input, sink(controller.signal));
    await waitUntil(() => sandbox.created.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sandbox.closed).toHaveLength(1);
  });

  it('notifies progress subscribers and unsubscribes at the terminal state', async () => {
    const { runtime } = setup([triageStep(DISPATCH), ...investigationSteps()], {
      sessions: () => shellSession(),
    });
    const outcome = await runtime.dispatch.consult(research, input, sink());
    if (outcome.kind !== 'dispatched') throw new Error('expected dispatch');
    const seen: string[] = [];
    runtime.dispatch.onProgress(outcome.dispatchId, (snapshot) => seen.push(snapshot.latestStatus));
    await runtime.dispatch.waitFor(outcome.dispatchId);
    expect(seen.at(-1)).toBe('Report ready');
  });

  it('exposes three built-in experts with valid tool names', () => {
    expect(EXPERTS.map((expert) => expert.id)).toEqual(['research', 'engineering', 'logistics']);
  });
});
