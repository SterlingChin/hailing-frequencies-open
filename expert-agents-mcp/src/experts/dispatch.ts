import { randomUUID } from 'node:crypto';
import type { AgentInputItem, Model, RunItemStreamEvent, Runner } from '@openai/agents';
import type { SandboxSession } from '@openai/agents/sandbox';
import { getErrorMessage, isAbortError } from '../errors.js';
import { buildInvestigatorAgent, investigationPrompt } from './investigator.js';
import type { ExpertDefinition } from './registry.js';
import { buildRequestManifest } from './sandbox.js';
import type { SandboxProvider } from './sandbox.js';
import { TRIAGE_MAX_TURNS, buildTriageAgent, triagePrompt } from './triage.js';
import type { ExpertInput, TriageDecision } from './triage.js';

/** Receives progress while a consultation runs. A `TaskHandle` satisfies this. */
export interface ProgressSink {
  readonly signal: AbortSignal;
  status(message: string): Promise<void>;
}

export const DISPATCHED_MARKER = 'EXPERT_AGENT_DISPATCHED';

export type ConsultOutcome =
  | { kind: 'answered'; expertId: string; summary: string; answer: string }
  | { kind: 'dispatched'; expertId: string; dispatchId: string; summary: string; plan: string }
  | { kind: 'capacity'; expertId: string; summary: string; plan: string };

export type DispatchStatus = 'working' | 'completed' | 'failed' | 'cancelled';

export interface DispatchSnapshot {
  dispatchId: string;
  expertId: string;
  status: DispatchStatus;
  latestStatus: string;
  statusLog: string[];
  startedAt: string;
  finishedAt?: string;
  report?: string;
  error?: string;
}

interface DispatchJob {
  snapshot: DispatchSnapshot;
  abort: AbortController;
  session: SandboxSession;
  done: Promise<void>;
  waiters: Set<() => void>;
  purgeTimer?: ReturnType<typeof setTimeout>;
}

export interface ExpertDispatchServiceOptions {
  sandbox: SandboxProvider;
  runner: Runner;
  model: string | Model;
  maxConcurrent: number;
  dispatchTtlMs: number;
  statusLogLimit?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

const TERMINAL: ReadonlySet<DispatchStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Runs expert consultations. `consult` performs the fast triage inside a sandbox session and either
 * answers or hands the session to a background investigation that the caller collects later.
 */
export class ExpertDispatchService {
  readonly #jobs = new Map<string, DispatchJob>();
  readonly #options: Required<
    Pick<ExpertDispatchServiceOptions, 'statusLogLimit' | 'now' | 'log'>
  > &
    ExpertDispatchServiceOptions;

  constructor(options: ExpertDispatchServiceOptions) {
    this.#options = {
      statusLogLimit: 50,
      now: () => new Date(),
      log: () => {},
      ...options,
    };
  }

  get activeCount(): number {
    let count = 0;
    for (const job of this.#jobs.values()) if (job.snapshot.status === 'working') count += 1;
    return count;
  }

  async consult(
    expert: ExpertDefinition,
    input: ExpertInput,
    progress: ProgressSink,
  ): Promise<ConsultOutcome> {
    progress.signal.throwIfAborted();
    await progress.status(`Starting sandbox for ${expert.title}…`);
    const session = await this.#options.sandbox.createSession(buildRequestManifest(input));
    const onAbort = () => {
      void closeQuietly(session);
    };
    progress.signal.addEventListener('abort', onAbort, { once: true });
    let handedOff = false;
    try {
      progress.signal.throwIfAborted();
      await progress.status(`${expert.title} started; triaging the request…`);
      const decision = await this.#triage(expert, input, session, progress.signal);

      if (decision.decision === 'answer_now') {
        return {
          kind: 'answered',
          expertId: expert.id,
          summary: decision.summary,
          answer: decision.answer ?? decision.summary,
        };
      }
      const plan = decision.plan ?? decision.summary;
      if (this.activeCount >= this.#options.maxConcurrent) {
        return { kind: 'capacity', expertId: expert.id, summary: decision.summary, plan };
      }
      const history = decision.history;
      const dispatchId = this.#startInvestigation(expert, session, history, plan);
      handedOff = true;
      return {
        kind: 'dispatched',
        expertId: expert.id,
        dispatchId,
        summary: decision.summary,
        plan,
      };
    } finally {
      progress.signal.removeEventListener('abort', onAbort);
      if (!handedOff) await closeQuietly(session);
    }
  }

  status(dispatchId: string): DispatchSnapshot | undefined {
    const job = this.#jobs.get(dispatchId);
    return job ? cloneSnapshot(job.snapshot) : undefined;
  }

  /** Resolves with the terminal snapshot, or rejects with AbortError when `signal` fires first. */
  async waitFor(dispatchId: string, signal?: AbortSignal): Promise<DispatchSnapshot | undefined> {
    const job = this.#jobs.get(dispatchId);
    if (!job) return undefined;
    while (!TERMINAL.has(job.snapshot.status)) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          job.waiters.delete(wake);
          reject(new DOMException('Wait aborted', 'AbortError'));
        };
        const wake = () => {
          job.waiters.delete(wake);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        job.waiters.add(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    return cloneSnapshot(job.snapshot);
  }

  /** Subscribes to status changes until the job is terminal. Returns an unsubscribe function. */
  onProgress(dispatchId: string, listener: (snapshot: DispatchSnapshot) => void): () => void {
    const job = this.#jobs.get(dispatchId);
    if (!job) return () => {};
    const wake = () => listener(cloneSnapshot(job.snapshot));
    job.waiters.add(wake);
    return () => job.waiters.delete(wake);
  }

  async cancel(dispatchId: string): Promise<boolean> {
    const job = this.#jobs.get(dispatchId);
    if (!job) return false;
    if (!TERMINAL.has(job.snapshot.status)) {
      job.abort.abort();
      await closeQuietly(job.session);
      await job.done;
    }
    return true;
  }

  async dispose(): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      if (job.purgeTimer) clearTimeout(job.purgeTimer);
      job.abort.abort();
    }
    await Promise.allSettled(jobs.map((job) => closeQuietly(job.session)));
    await Promise.allSettled(jobs.map((job) => job.done));
    this.#jobs.clear();
  }

  async #triage(
    expert: ExpertDefinition,
    input: ExpertInput,
    session: SandboxSession,
    signal: AbortSignal,
  ): Promise<TriageDecision & { history: AgentInputItem[] }> {
    const agent = buildTriageAgent(expert, this.#options.model);
    const result = await this.#options.runner.run(agent, triagePrompt(input), {
      sandbox: { session },
      maxTurns: TRIAGE_MAX_TURNS,
      signal,
    });
    const decision = result.finalOutput;
    if (!decision) throw new Error('Triage produced no decision');
    return { ...decision, history: result.history };
  }

  #startInvestigation(
    expert: ExpertDefinition,
    session: SandboxSession,
    history: AgentInputItem[],
    plan: string,
  ): string {
    const dispatchId = randomUUID();
    const abort = new AbortController();
    const startedAt = this.#options.now().toISOString();
    const job: DispatchJob = {
      snapshot: {
        dispatchId,
        expertId: expert.id,
        status: 'working',
        latestStatus: 'Investigation started',
        statusLog: ['Investigation started'],
        startedAt,
      },
      abort,
      session,
      waiters: new Set(),
      done: Promise.resolve(),
    };
    this.#jobs.set(dispatchId, job);
    job.done = this.#investigate(expert, job, history, plan);
    return dispatchId;
  }

  async #investigate(
    expert: ExpertDefinition,
    job: DispatchJob,
    history: AgentInputItem[],
    plan: string,
  ): Promise<void> {
    const agent = buildInvestigatorAgent(expert, this.#options.model);
    try {
      const stream = await this.#options.runner.run(
        agent,
        [...history, { role: 'user', content: investigationPrompt(plan) }],
        {
          sandbox: { session: job.session },
          stream: true,
          signal: job.abort.signal,
          maxTurns: expert.maxTurns,
        },
      );
      for await (const event of stream) {
        if (event.type === 'run_item_stream_event') this.#noteEvent(job, event);
      }
      await stream.completed;
      if (job.abort.signal.aborted || stream.cancelled) {
        this.#finish(job, 'cancelled', 'Cancelled');
        return;
      }
      const report = typeof stream.finalOutput === 'string' ? stream.finalOutput : undefined;
      if (report === undefined) throw new Error('Investigation produced no report');
      job.snapshot.report = report;
      this.#finish(job, 'completed', 'Report ready');
    } catch (err) {
      if (job.abort.signal.aborted || isAbortError(err)) {
        this.#finish(job, 'cancelled', 'Cancelled');
      } else {
        const message = getErrorMessage(err);
        this.#options.log(`dispatch ${job.snapshot.dispatchId} failed: ${message}`);
        job.snapshot.error = message;
        this.#finish(job, 'failed', 'Investigation failed');
      }
    } finally {
      await closeQuietly(job.session);
    }
  }

  #noteEvent(job: DispatchJob, event: RunItemStreamEvent): void {
    const message = describeRunItem(event);
    if (message) this.#pushStatus(job, message);
  }

  #pushStatus(job: DispatchJob, message: string): void {
    job.snapshot.latestStatus = message;
    job.snapshot.statusLog.push(message);
    const overflow = job.snapshot.statusLog.length - this.#options.statusLogLimit;
    if (overflow > 0) job.snapshot.statusLog.splice(0, overflow);
    this.#notify(job);
  }

  #finish(job: DispatchJob, status: DispatchStatus, message: string): void {
    job.snapshot.status = status;
    job.snapshot.finishedAt = this.#options.now().toISOString();
    this.#pushStatus(job, message);
    job.purgeTimer = setTimeout(
      () => this.#jobs.delete(job.snapshot.dispatchId),
      this.#options.dispatchTtlMs,
    );
    job.purgeTimer.unref?.();
  }

  #notify(job: DispatchJob): void {
    const wakers = [...job.waiters];
    if (TERMINAL.has(job.snapshot.status)) job.waiters.clear();
    for (const wake of wakers) wake();
  }
}

function cloneSnapshot(snapshot: DispatchSnapshot): DispatchSnapshot {
  return { ...snapshot, statusLog: [...snapshot.statusLog] };
}

async function closeQuietly(session: SandboxSession): Promise<void> {
  try {
    await session.close?.();
  } catch {
    // Cleanup must not replace the original consultation error.
  }
}

const MAX_COMMAND_PREVIEW = 80;

/** Turns a run item event into a short, safe status line (tool names and truncated commands only). */
export function describeRunItem(event: RunItemStreamEvent): string | undefined {
  if (event.name !== 'tool_called') return undefined;
  const raw = event.item.rawItem as Record<string, unknown>;
  const type = typeof raw['type'] === 'string' ? raw['type'] : 'tool';
  if (type === 'function_call' && typeof raw['name'] === 'string') {
    const preview = commandPreview(raw['arguments']);
    return preview ? `Running ${raw['name']}: ${preview}` : `Running ${raw['name']}`;
  }
  if (type === 'shell_call') {
    const action = raw['action'] as { commands?: unknown } | undefined;
    const commands = Array.isArray(action?.commands) ? action.commands : [];
    const first = commands.find((c): c is string => typeof c === 'string');
    return first ? `Running shell: ${truncate(first)}` : 'Running shell command';
  }
  if (type === 'apply_patch_call') return 'Editing workspace files';
  return `Running ${type.replace(/_call$/, '').replace(/_/g, ' ')}`;
}

function commandPreview(args: unknown): string | undefined {
  if (typeof args !== 'string') return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const cmd = parsed['cmd'] ?? parsed['command'];
    return typeof cmd === 'string' ? truncate(cmd) : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_COMMAND_PREVIEW ? `${single.slice(0, MAX_COMMAND_PREVIEW)}…` : single;
}
