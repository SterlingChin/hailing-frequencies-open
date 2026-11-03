import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getErrorMessage, isAbortError } from '../errors.js';
import type { ExpertDispatchService, ProgressSink } from '../experts/dispatch.js';
import type { ExpertDefinition } from '../experts/registry.js';
import { expertToolName } from '../experts/registry.js';
import type { InMemoryTaskStore } from '../tasks/in-memory-store.js';
import { declaresTasksExtension } from '../tasks/tasks-extension.js';
import type { TasksExtension } from '../tasks/tasks-extension.js';
import type { TaskHandle } from '../tasks/types.js';
import {
  CANCEL_TOOL,
  COLLECT_TOOL,
  LIST_TOOL,
  STATUS_TOOL,
  errorResult,
  expertsListResult,
  outcomeResult,
  reportResult,
  statusResult,
  unknownDispatchResult,
} from './results.js';

export interface ToolDependencies {
  tasks: TasksExtension;
  store: InMemoryTaskStore;
  dispatch: ExpertDispatchService;
  experts: readonly ExpertDefinition[];
  taskTtlMs: number;
  pollIntervalMs: number;
  log?: (message: string) => void;
}

const ExpertInputSchema = z.object({
  question: z.string().min(1).max(20_000).describe('What you need from the expert.'),
  context: z
    .string()
    .max(200_000)
    .optional()
    .describe(
      'Optional supporting material (logs, code, notes). Saved as request/context.md in the sandbox.',
    ),
});

const DispatchIdSchema = z.object({
  dispatchId: z
    .string()
    .min(1)
    .max(100)
    .describe('The dispatchId returned with EXPERT_AGENT_DISPATCHED.'),
});

const INTERNAL_ERROR = -32_603;

export function registerExpertTools(mcp: McpServer, deps: ToolDependencies): void {
  const log = deps.log ?? (() => {});
  const taskOptions = { ttlMs: deps.taskTtlMs, pollIntervalMs: deps.pollIntervalMs };

  for (const expert of deps.experts) {
    mcp.registerTool(
      expertToolName(expert),
      {
        title: expert.title,
        description: `${expert.description} Returns either a direct answer or ${'EXPERT_AGENT_DISPATCHED'} with a dispatchId to collect later via ${COLLECT_TOOL}. Supports the MCP Tasks extension: with it, the call returns a task whose status reports the sandbox starting up.`,
        inputSchema: ExpertInputSchema,
      },
      async (input, ctx) => {
        if (!declaresTasksExtension(ctx)) {
          return runInline(
            () => deps.dispatch.consult(expert, input, inlineSink(ctx)),
            outcomeResult,
          );
        }
        const task = await deps.tasks.create(ctx, taskOptions);
        const handle = deps.store.handle(task.taskId);
        void driveTask(
          handle,
          () => deps.dispatch.consult(expert, input, handle),
          outcomeResult,
          log,
        );
        return task;
      },
    );
  }

  mcp.registerTool(
    COLLECT_TOOL,
    {
      title: 'Collect expert report',
      description:
        'Waits for a dispatched expert investigation and returns its report. With the MCP Tasks extension the call returns a task that mirrors the investigation progress; without it, returns the report if ready or the current status.',
      inputSchema: DispatchIdSchema,
    },
    async ({ dispatchId }, ctx) => {
      const snapshot = deps.dispatch.status(dispatchId);
      if (!snapshot) return unknownDispatchResult();
      if (!declaresTasksExtension(ctx)) return reportResult(snapshot);

      const task = await deps.tasks.create(ctx, taskOptions);
      const handle = deps.store.handle(task.taskId);
      void driveTask(
        handle,
        async () => {
          const unsubscribe = deps.dispatch.onProgress(dispatchId, (progress) => {
            void handle.status(progress.latestStatus);
          });
          try {
            await handle.status(snapshot.latestStatus);
            const final = await deps.dispatch.waitFor(dispatchId, handle.signal);
            if (!final) throw new Error('Dispatch disappeared while waiting');
            return final;
          } finally {
            unsubscribe();
          }
        },
        reportResult,
        log,
      );
      return task;
    },
  );

  mcp.registerTool(
    STATUS_TOOL,
    {
      title: 'Expert dispatch status',
      description: 'Shows what a dispatched expert is doing right now, without waiting.',
      inputSchema: DispatchIdSchema,
    },
    async ({ dispatchId }) => {
      const snapshot = deps.dispatch.status(dispatchId);
      return snapshot ? statusResult(snapshot) : unknownDispatchResult();
    },
  );

  mcp.registerTool(
    CANCEL_TOOL,
    {
      title: 'Cancel expert dispatch',
      description: 'Stops a dispatched expert investigation and tears down its sandbox.',
      inputSchema: DispatchIdSchema,
    },
    async ({ dispatchId }) => {
      const found = await deps.dispatch.cancel(dispatchId);
      if (!found) return unknownDispatchResult();
      const snapshot = deps.dispatch.status(dispatchId);
      return snapshot ? statusResult(snapshot) : errorResult('Dispatch already purged');
    },
  );

  mcp.registerTool(
    LIST_TOOL,
    {
      title: 'List experts',
      description: 'Lists the available expert agents and the tool name for each.',
      inputSchema: z.object({}),
    },
    async () => expertsListResult(deps.experts),
  );
}

function inlineSink(ctx: ServerContext): ProgressSink {
  return { signal: ctx.mcpReq.signal, status: async () => {} };
}

async function runInline<T>(
  work: () => Promise<T>,
  project: (value: T) => CallToolResult,
): Promise<CallToolResult> {
  try {
    return project(await work());
  } catch (err) {
    // OX Agent: javascript-server-hardening prevented (error formatted, never forwarded raw)
    const message = getErrorMessage(err);
    return errorResult(`Expert consultation failed: ${message}`);
  }
}

/** Runs background work for a task and settles the task; cancellation leaves the store's state alone. */
async function driveTask<T>(
  handle: TaskHandle,
  work: () => Promise<T>,
  project: (value: T) => CallToolResult,
  log: (message: string) => void,
): Promise<void> {
  try {
    const value = await work();
    if (handle.signal.aborted) return;
    await handle.complete(project(value));
  } catch (err) {
    if (handle.signal.aborted || isAbortError(err)) return;
    // OX Agent: javascript-server-hardening prevented (error formatted, never forwarded raw)
    const message = getErrorMessage(err);
    log(`task ${handle.taskId} failed: ${message}`);
    await handle.fail({ code: INTERNAL_ERROR, message: `Expert consultation failed: ${message}` });
  }
}
