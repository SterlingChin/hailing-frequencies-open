import {
  CLIENT_CAPABILITIES_META_KEY,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import type { Server, ServerContext } from '@modelcontextprotocol/server';
import {
  TASK_METHODS,
  TASKS_EXTENSION_ID,
  TaskIdParamsSchema,
  UpdateTaskParamsSchema,
} from './types.js';
import type { InputResponses, TaskStore, TaskToolResult } from './types.js';

export interface TasksExtensionOptions {
  /** Default task lifetime. `null` keeps tasks until the process exits. */
  defaultTtlMs?: number | null;
  defaultPollIntervalMs?: number;
}

export interface CreateTaskOptions {
  ttlMs?: number | null;
  pollIntervalMs?: number;
  context?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the request's `_meta` envelope declares the Tasks extension. The SDK lifts the reserved
 * `io.modelcontextprotocol/clientCapabilities` key out of `_meta` into `ctx.mcpReq.envelope`.
 */
export function declaresTasksExtension(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities['extensions'];
  return isRecord(extensions) && TASKS_EXTENSION_ID in extensions;
}

function requireTasksExtension(ctx: ServerContext, method: string): void {
  if (declaresTasksExtension(ctx)) return;
  throw new MissingRequiredClientCapabilityError(
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
    `${method} requires the client to declare the ${TASKS_EXTENSION_ID} extension`,
  );
}

function principalOf(ctx: ServerContext): string | undefined {
  return ctx.http?.authInfo?.clientId;
}

function notFound(): never {
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    'Failed to retrieve task: Task not found',
  );
}

/**
 * Server half of the Tasks extension on `@modelcontextprotocol/server` 2.3.1, which has no
 * extension hooks yet. Call `install(mcp.server)` and `advertise(mcp.server)` before the first
 * `registerTool`, then return `await tasks.create(ctx, …)` from task-capable tool handlers.
 */
export class TasksExtension {
  readonly id = TASKS_EXTENSION_ID;
  readonly store: TaskStore;
  readonly #defaultTtlMs: number | null;
  readonly #defaultPollIntervalMs: number;

  constructor(store: TaskStore, options: TasksExtensionOptions = {}) {
    this.store = store;
    this.#defaultTtlMs = options.defaultTtlMs === undefined ? 86_400_000 : options.defaultTtlMs;
    this.#defaultPollIntervalMs = options.defaultPollIntervalMs ?? 5000;
  }

  /** Advertises `capabilities.extensions[io.modelcontextprotocol/tasks] = {}` (must be exactly empty). */
  advertise(server: Server): void {
    server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
  }

  install(server: Server): void {
    server.setRequestHandler(
      TASK_METHODS.get,
      { params: TaskIdParamsSchema },
      async (params, ctx) => {
        requireTasksExtension(ctx, TASK_METHODS.get);
        const task = await this.store.get(params.taskId, { principal: principalOf(ctx) });
        if (task === undefined) return notFound();
        return { resultType: 'complete' as const, ...task };
      },
    );

    server.setRequestHandler(
      TASK_METHODS.update,
      { params: UpdateTaskParamsSchema },
      async (params, ctx) => {
        requireTasksExtension(ctx, TASK_METHODS.update);
        // The protocol layer lifts `inputResponses` out of the params on retried requests.
        const lifted = ctx.mcpReq.inputResponses as InputResponses | undefined;
        const inputResponses = lifted ?? params.inputResponses ?? {};
        const found = await this.store.update(params.taskId, inputResponses, {
          principal: principalOf(ctx),
        });
        if (!found) return notFound();
        return { resultType: 'complete' as const };
      },
    );

    server.setRequestHandler(
      TASK_METHODS.cancel,
      { params: TaskIdParamsSchema },
      async (params, ctx) => {
        requireTasksExtension(ctx, TASK_METHODS.cancel);
        const found = await this.store.cancel(params.taskId, { principal: principalOf(ctx) });
        if (!found) return notFound();
        return { resultType: 'complete' as const };
      },
    );
  }

  /** Creates a task for the current `tools/call` and returns the flat `CreateTaskResult`. */
  async create(ctx: ServerContext, options: CreateTaskOptions = {}): Promise<TaskToolResult> {
    requireTasksExtension(ctx, 'tools/call');
    const task = await this.store.create({
      ttlMs: options.ttlMs === undefined ? this.#defaultTtlMs : options.ttlMs,
      pollIntervalMs: options.pollIntervalMs ?? this.#defaultPollIntervalMs,
      principal: principalOf(ctx),
      ...(options.context !== undefined && { context: options.context }),
    });
    return { resultType: 'task', ...task } as TaskToolResult;
  }
}
