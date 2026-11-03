import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InMemoryTaskStore } from '../../src/tasks/in-memory-store.js';
import { TasksExtension, declaresTasksExtension } from '../../src/tasks/tasks-extension.js';
import {
  CreateTaskResultSchema,
  DetailedTaskSchema,
  WireClient,
  expectError,
  expectResult,
  pollTask,
} from '../helpers/wire.js';

function buildHandler(store: InMemoryTaskStore): McpHttpHandler {
  const tasks = new TasksExtension(store, { defaultTtlMs: 60_000, defaultPollIntervalMs: 50 });
  return createMcpHandler(
    () => {
      const mcp = new McpServer({ name: 'tasks-test', version: '0.0.0' });
      tasks.advertise(mcp.server);
      tasks.install(mcp.server);
      mcp.registerTool(
        'slow_echo',
        { description: 'Echoes after a tick', inputSchema: z.object({ text: z.string() }) },
        async ({ text }, ctx) => {
          if (!declaresTasksExtension(ctx)) {
            return { content: [{ type: 'text', text: `inline:${text}` }] };
          }
          const task = await tasks.create(ctx);
          const handle = store.handle(task.taskId);
          void (async () => {
            await handle.status('working on it');
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (handle.signal.aborted) return;
            await handle.complete({ content: [{ type: 'text', text: `task:${text}` }] });
          })();
          return task;
        },
      );
      return mcp;
    },
    { legacy: 'reject' },
  );
}

describe('TasksExtension over the 2026-07-28 wire', () => {
  const stores: InMemoryTaskStore[] = [];
  const handlers: McpHttpHandler[] = [];
  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.close();
    for (const store of stores.splice(0)) store.close();
  });

  function setup() {
    const store = new InMemoryTaskStore();
    const handler = buildHandler(store);
    stores.push(store);
    handlers.push(handler);
    return { store, client: new WireClient((request) => handler.fetch(request)) };
  }

  it('advertises the extension in server/discover', async () => {
    const { client } = setup();
    const result = expectResult(await client.call('server/discover'));
    expect(result).toMatchObject({
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });
  });

  it('creates a task from tools/call and resolves it through tasks/get', async () => {
    const { client } = setup();
    const created = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'slow_echo', arguments: { text: 'hi' } }),
      ),
    );
    expect(created).toMatchObject({ status: 'working', ttlMs: 60_000, pollIntervalMs: 50 });

    const done = await pollTask(client, created.taskId, (task) => task.status === 'completed');
    expect(done.result).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'task:hi' }],
    });
  });

  it('falls back to an inline CallToolResult when the client does not declare tasks', async () => {
    const { client } = setup();
    const result = expectResult(
      await client.call(
        'tools/call',
        { name: 'slow_echo', arguments: { text: 'hi' } },
        { tasks: false },
      ),
    );
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'inline:hi' }] });
  });

  it('rejects tasks/* from clients that do not declare the extension with -32021', async () => {
    const { client, store } = setup();
    const task = await store.create({ ttlMs: null });
    const error = expectError(
      await client.call('tasks/get', { taskId: task.taskId }, { tasks: false }),
    );
    expect(error.code).toBe(-32_021);
  });

  it('returns -32602 for unknown task ids on get, update and cancel', async () => {
    const { client } = setup();
    for (const method of ['tasks/get', 'tasks/cancel']) {
      const error = expectError(await client.call(method, { taskId: 'nope' }));
      expect(error.code).toBe(-32_602);
      expect(error.message).toContain('Task not found');
    }
    const error = expectError(
      await client.call('tasks/update', { taskId: 'nope', inputResponses: {} }),
    );
    expect(error.code).toBe(-32_602);
  });

  it('cancels a working task cooperatively', async () => {
    const { client } = setup();
    const created = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'slow_echo', arguments: { text: 'x' } }),
      ),
    );
    expect(
      expectResult(await client.call('tasks/cancel', { taskId: created.taskId })),
    ).toMatchObject({ resultType: 'complete' });
    const task = DetailedTaskSchema.parse(
      expectResult(await client.call('tasks/get', { taskId: created.taskId })),
    );
    expect(task.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      DetailedTaskSchema.parse(
        expectResult(await client.call('tasks/get', { taskId: created.taskId })),
      ).status,
    ).toBe('cancelled');
  });

  it('rejects a modern POST that lacks the Mcp-Name header', async () => {
    const { client } = setup();
    const response = await client.call(
      'tools/call',
      { name: 'slow_echo', arguments: { text: 'x' } },
      { headers: { 'mcp-name': '' } },
    );
    expect(response.kind).toBe('error');
    expect(response.status).toBe(400);
  });
});
