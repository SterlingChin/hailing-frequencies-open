import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * Minimal 2026-07-28 JSON-RPC client over a fetch-shaped function. It sends the per-request `_meta`
 * envelope and the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers the entry demands.
 */

export const PROTOCOL_VERSION = '2026-07-28';
export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

type FetchLike = (request: Request) => Promise<Response>;

export interface WireOptions {
  /** Declare the Tasks extension in the envelope (default true). */
  tasks?: boolean;
  headers?: Record<string, string>;
}

export type WireResponse =
  | { kind: 'result'; status: number; result: Record<string, unknown> }
  | { kind: 'error'; status: number; error: { code: number; message: string; data?: unknown } };

const MCP_NAME_SOURCE: Record<string, string> = {
  'tools/call': 'name',
  'tasks/get': 'taskId',
  'tasks/update': 'taskId',
  'tasks/cancel': 'taskId',
};

export class WireClient {
  #nextId = 1;
  readonly #fetch: FetchLike;
  readonly #url: string;

  constructor(fetchLike: FetchLike, url = 'http://127.0.0.1/mcp') {
    this.#fetch = fetchLike;
    this.#url = url;
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    options: WireOptions = {},
  ): Promise<WireResponse> {
    const extensions = options.tasks === false ? {} : { [TASKS_EXTENSION_ID]: {} };
    const body = {
      jsonrpc: '2.0',
      id: this.#nextId++,
      method,
      params: {
        ...params,
        _meta: {
          ...(params['_meta'] as Record<string, unknown> | undefined),
          [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'wire-test-client', version: '0.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: { extensions },
        },
      },
    };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method,
    };
    const nameField = MCP_NAME_SOURCE[method];
    if (nameField) headers['mcp-name'] = String(params[nameField]);
    // Caller overrides win; an empty string removes the header.
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === '') delete headers[key];
      else headers[key] = value;
    }
    const response = await this.#fetch(
      new Request(this.#url, { method: 'POST', headers, body: JSON.stringify(body) }),
    );
    const text = await response.text();
    const message = parseEnvelope(text);
    if ('error' in message && message.error) {
      return { kind: 'error', status: response.status, error: message.error };
    }
    return { kind: 'result', status: response.status, result: message.result ?? {} };
  }
}

const JsonRpcMessageSchema = z.object({
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

function parseEnvelope(text: string): z.infer<typeof JsonRpcMessageSchema> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JsonRpcMessageSchema.parse(JSON.parse(trimmed));
  // SSE fallback: take the last data: line.
  const dataLines = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const last = dataLines.at(-1);
  if (!last) throw new Error(`Unparseable response body: ${trimmed.slice(0, 200)}`);
  return JsonRpcMessageSchema.parse(JSON.parse(last));
}

export const TaskSchema = z.object({
  taskId: z.string(),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.number().int().nullable(),
  pollIntervalMs: z.number().int().optional(),
});

export const CreateTaskResultSchema = TaskSchema.extend({ resultType: z.literal('task') });

export const DetailedTaskSchema = TaskSchema.extend({
  resultType: z.literal('complete'),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  inputRequests: z.record(z.string(), z.unknown()).optional(),
});

export const CallToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

export function expectResult(response: WireResponse): Record<string, unknown> {
  if (response.kind !== 'result') {
    throw new Error(`Expected result, got error ${response.error.code}: ${response.error.message}`);
  }
  return response.result;
}

export function expectError(response: WireResponse): { code: number; message: string } {
  if (response.kind !== 'error') {
    throw new Error(`Expected error, got result ${JSON.stringify(response.result).slice(0, 200)}`);
  }
  return response.error;
}

export async function pollTask(
  client: WireClient,
  taskId: string,
  until: (task: z.infer<typeof DetailedTaskSchema>) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<z.infer<typeof DetailedTaskSchema>> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    const task = DetailedTaskSchema.parse(expectResult(await client.call('tasks/get', { taskId })));
    if (until(task)) return task;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for task ${taskId}: ${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 10));
  }
}
