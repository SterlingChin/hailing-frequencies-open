import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Wire shapes of the MCP Tasks extension, schema revision 2026-07-28
 * (https://github.com/modelcontextprotocol/ext-tasks). The TypeScript SDK does not ship a server
 * implementation yet; these mirror the unreleased `@modelcontextprotocol/server/ext/tasks` API so
 * the swap is mechanical when it lands.
 */

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks' as const;

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Input requests keyed by a task-unique identifier (shape is opaque to this server). */
export type InputRequests = Record<string, unknown>;
export type InputResponses = Record<string, unknown>;

export interface WorkingTask extends Task {
  status: 'working';
}
export interface InputRequiredTask extends Task {
  status: 'input_required';
  inputRequests: InputRequests;
}
export interface CompletedTask extends Task {
  status: 'completed';
  result: Record<string, unknown>;
}
export interface FailedTask extends Task {
  status: 'failed';
  error: JsonRpcErrorObject;
}
export interface CancelledTask extends Task {
  status: 'cancelled';
}
export type DetailedTask =
  WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

/** Flat task result returned from `tools/call` in place of a `CallToolResult`. */
export type CreateTaskResult = Task & { resultType: 'task' };

/**
 * What a task-creating tool handler returns. The SDK validates `tools/call` results against the
 * loose 2026 `CallToolResult` schema and forwards `resultType: 'task'` verbatim.
 */
export type TaskToolResult = CallToolResult & CreateTaskResult;

export interface CreateTaskParams {
  ttlMs: number | null;
  pollIntervalMs?: number;
  principal?: string;
  context?: Record<string, unknown>;
}

export interface TaskAccess {
  principal?: string;
}

export interface TaskStore {
  create(params: CreateTaskParams): Promise<Task>;
  get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined>;
  update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean>;
  cancel(taskId: string, access?: TaskAccess): Promise<boolean>;
}

/** Worker-side handle for driving a task to a terminal state. */
export interface TaskHandle {
  readonly taskId: string;
  /** Aborted when `tasks/cancel` is acknowledged for this task. */
  readonly signal: AbortSignal;
  status(message: string): Promise<void>;
  requireInput(requests: InputRequests): Promise<InputResponses>;
  complete(result: CallToolResult): Promise<void>;
  fail(error: JsonRpcErrorObject): Promise<void>;
}

export const TaskIdParamsSchema = z.object({ taskId: z.string().min(1) });
export const UpdateTaskParamsSchema = TaskIdParamsSchema.extend({
  inputResponses: z.record(z.string(), z.unknown()).optional(),
});

export const TASK_METHODS = {
  get: 'tasks/get',
  update: 'tasks/update',
  cancel: 'tasks/cancel',
  notification: 'notifications/tasks',
} as const;
