import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type {
  CreateTaskParams,
  DetailedTask,
  InputRequests,
  InputResponses,
  JsonRpcErrorObject,
  Task,
  TaskAccess,
  TaskHandle,
  TaskStatus,
  TaskStore,
} from './types.js';

interface PendingInput {
  requests: InputRequests;
  responses: InputResponses;
  resolve: (responses: InputResponses) => void;
  reject: (reason: unknown) => void;
}

interface TaskRecord {
  task: Task;
  principal?: string;
  context?: Record<string, unknown>;
  result?: CallToolResult;
  error?: JsonRpcErrorObject;
  pendingInput?: PendingInput;
  abort: AbortController;
  purgeTimer?: ReturnType<typeof setTimeout>;
}

export interface InMemoryTaskStoreOptions {
  createTaskId?: () => string;
  now?: () => Date;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Single-process task store. Tasks live for `ttlMs` after creation (or forever when `null`), cancel
 * aborts the worker's signal, and writes after a terminal state are ignored so a late worker cannot
 * resurrect a cancelled task.
 */
export class InMemoryTaskStore implements TaskStore {
  readonly #records = new Map<string, TaskRecord>();
  readonly #createTaskId: () => string;
  readonly #now: () => Date;

  constructor(options: InMemoryTaskStoreOptions = {}) {
    this.#createTaskId = options.createTaskId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async create(params: CreateTaskParams): Promise<Task> {
    const createdAt = this.#now().toISOString();
    const task: Task = {
      taskId: this.#createTaskId(),
      status: 'working',
      createdAt,
      lastUpdatedAt: createdAt,
      ttlMs: params.ttlMs,
      ...(params.pollIntervalMs !== undefined && { pollIntervalMs: params.pollIntervalMs }),
    };
    const record: TaskRecord = {
      task,
      abort: new AbortController(),
      ...(params.principal !== undefined && { principal: params.principal }),
      ...(params.context !== undefined && { context: params.context }),
    };
    if (params.ttlMs !== null) {
      record.purgeTimer = setTimeout(() => this.#purge(task.taskId), params.ttlMs);
      record.purgeTimer.unref?.();
    }
    this.#records.set(task.taskId, record);
    return { ...task };
  }

  async get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined> {
    const record = this.#lookup(taskId, access);
    return record ? this.#detailed(record) : undefined;
  }

  async update(
    taskId: string,
    inputResponses: InputResponses,
    access?: TaskAccess,
  ): Promise<boolean> {
    const record = this.#lookup(taskId, access);
    if (!record) return false;
    const pending = record.pendingInput;
    if (!pending || record.task.status !== 'input_required') return true;
    for (const [key, value] of Object.entries(inputResponses)) {
      if (Object.hasOwn(pending.requests, key)) pending.responses[key] = value;
    }
    const outstanding = Object.keys(pending.requests).filter(
      (key) => !Object.hasOwn(pending.responses, key),
    );
    if (outstanding.length === 0) {
      delete record.pendingInput;
      this.#transition(record, 'working', 'Input received');
      pending.resolve({ ...pending.responses });
    }
    return true;
  }

  async cancel(taskId: string, access?: TaskAccess): Promise<boolean> {
    const record = this.#lookup(taskId, access);
    if (!record) return false;
    if (TERMINAL.has(record.task.status)) return true;
    const pending = record.pendingInput;
    delete record.pendingInput;
    this.#transition(record, 'cancelled', 'Cancelled by client');
    pending?.reject(new DOMException('Task cancelled', 'AbortError'));
    record.abort.abort();
    return true;
  }

  /** Worker-side handle. Throws for unknown task ids. */
  handle(taskId: string): TaskHandle {
    const record = this.#records.get(taskId);
    if (!record) throw new Error('Unknown task');
    return {
      taskId,
      signal: record.abort.signal,
      status: async (message) => {
        const live = this.#live(taskId);
        if (live) this.#transition(live, live.task.status, message);
      },
      requireInput: (requests) => this.#requireInput(taskId, requests),
      complete: async (result) => {
        const live = this.#live(taskId);
        if (!live) return;
        live.result = result;
        this.#transition(live, 'completed', 'Completed');
      },
      fail: async (error) => {
        const live = this.#live(taskId);
        if (!live) return;
        live.error = { code: error.code, message: error.message };
        this.#transition(live, 'failed', error.message);
      },
    };
  }

  context(taskId: string): Record<string, unknown> | undefined {
    return this.#records.get(taskId)?.context;
  }

  /** Drops every task and timer. */
  close(): void {
    for (const record of this.#records.values()) {
      if (record.purgeTimer) clearTimeout(record.purgeTimer);
      record.pendingInput?.reject(new DOMException('Store closed', 'AbortError'));
      record.abort.abort();
    }
    this.#records.clear();
  }

  #requireInput(taskId: string, requests: InputRequests): Promise<InputResponses> {
    const record = this.#live(taskId);
    if (!record) return Promise.reject(new DOMException('Task is terminal', 'AbortError'));
    return new Promise<InputResponses>((resolve, reject) => {
      record.pendingInput = { requests, responses: {}, resolve, reject };
      this.#transition(record, 'input_required', 'Waiting for input');
    });
  }

  #lookup(taskId: string, access?: TaskAccess): TaskRecord | undefined {
    const record = this.#records.get(taskId);
    if (!record) return undefined;
    // A foreign principal gets "not found" rather than an existence leak.
    if (record.principal !== undefined && record.principal !== access?.principal) return undefined;
    return record;
  }

  #live(taskId: string): TaskRecord | undefined {
    const record = this.#records.get(taskId);
    return record && !TERMINAL.has(record.task.status) ? record : undefined;
  }

  #transition(record: TaskRecord, status: TaskStatus, statusMessage?: string): void {
    record.task = {
      ...record.task,
      status,
      lastUpdatedAt: this.#now().toISOString(),
      ...(statusMessage !== undefined ? { statusMessage } : {}),
    };
  }

  #purge(taskId: string): void {
    const record = this.#records.get(taskId);
    if (!record) return;
    record.pendingInput?.reject(new DOMException('Task expired', 'AbortError'));
    record.abort.abort();
    this.#records.delete(taskId);
  }

  #detailed(record: TaskRecord): DetailedTask {
    const base = { ...record.task };
    switch (base.status) {
      case 'input_required': {
        const pending = record.pendingInput;
        const unanswered: InputRequests = {};
        if (pending) {
          for (const [key, request] of Object.entries(pending.requests)) {
            if (!Object.hasOwn(pending.responses, key)) unanswered[key] = request;
          }
        }
        return { ...base, status: 'input_required', inputRequests: unanswered };
      }
      case 'completed':
        return {
          ...base,
          status: 'completed',
          // ext-tasks clients require the stored CallToolResult to carry resultType 'complete'.
          result: { resultType: 'complete', ...(record.result ?? { content: [] }) },
        };
      case 'failed':
        return {
          ...base,
          status: 'failed',
          error: record.error ?? { code: -32_603, message: 'Task failed' },
        };
      case 'cancelled':
        return { ...base, status: 'cancelled' };
      case 'working':
      default:
        return { ...base, status: 'working' };
    }
  }
}
