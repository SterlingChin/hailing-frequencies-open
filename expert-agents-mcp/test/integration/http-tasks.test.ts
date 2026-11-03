import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { startHttpServer } from '../../src/http.js';
import type { RunningHttpServer } from '../../src/http.js';
import {
  ANSWER_NOW,
  DISPATCH,
  REPORT,
  buildTestRuntime,
  hangingStep,
  investigationSteps,
  shellSession,
  triageStep,
  waitUntil,
} from '../helpers/doubles.js';
import type { TestRuntime } from '../helpers/doubles.js';
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  WireClient,
  expectError,
  expectResult,
  pollTask,
} from '../helpers/wire.js';

const question = { question: 'Why does replicator RPL-2400 make cold tea?', context: 'HF-042' };

describe('Expert Agent server over Streamable HTTP with the Tasks extension', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function serve(
    ...args: Parameters<typeof buildTestRuntime>
  ): Promise<TestRuntime & { http: RunningHttpServer; client: WireClient }> {
    const built = buildTestRuntime(...args);
    const handler = built.runtime.createHandler();
    const http = await startHttpServer({
      handler,
      host: '127.0.0.1',
      port: 0,
      requireToken: false,
    });
    cleanups.push(async () => {
      await http.close();
      await handler.close();
      await built.runtime.dispose();
    });
    const client = new WireClient((request) => fetch(request), http.url);
    return { ...built, http, client };
  }

  it('advertises the tasks extension and serves health and 404s', async () => {
    const { client, http } = await serve([]);
    const discover = expectResult(await client.call('server/discover'));
    expect(discover).toMatchObject({
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      supportedVersions: expect.arrayContaining(['2026-07-28']),
    });
    const base = http.url.replace(/\/mcp$/, '');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    const health = await fetch(`${base}/healthz`);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('accepts a configured public Host when bound on all interfaces and rejects foreign hosts', async () => {
    const { runtime } = await serve([]);
    const handler = runtime.createHandler();
    const http = await startHttpServer({
      handler,
      host: '0.0.0.0',
      port: 0,
      requireToken: false,
      allowedHosts: ['experts.up.railway.app'],
    });
    cleanups.push(async () => {
      await http.close();
      await handler.close();
    });
    const url = http.url.replace('0.0.0.0', '127.0.0.1');
    const client = new WireClient(async (request) => {
      const headers = new Headers(request.headers);
      headers.set('host', 'experts.up.railway.app');
      const body = await request.text();
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          request.url,
          { method: 'POST', headers: Object.fromEntries(headers) },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () => resolve(new Response(text, { status: res.statusCode })));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    }, url);
    expect(expectResult(await client.call('server/discover'))).toHaveProperty('capabilities');
    expect(
      (await fetch(url, { method: 'POST', headers: { host: 'foreign.example' }, body: '{}' }))
        .status,
    ).toBe(403);
  });

  it('rejects requests with a foreign Host header and requires a bearer token when configured', async () => {
    const { http, runtime } = await serve([]);
    const base = http.url.replace(/\/mcp$/, '');
    const spoofed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(spoofed.status).toBeGreaterThanOrEqual(400);

    const guarded = await startHttpServer({
      handler: runtime.createHandler(),
      host: '127.0.0.1',
      port: 0,
      requireToken: true,
    });
    cleanups.push(() => guarded.close());
    const denied = await fetch(guarded.url, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'Unauthorized' });
  });

  it('runs an expert as a task that completes with a direct answer', async () => {
    const { client, sandbox } = await serve([triageStep(ANSWER_NOW)]);
    const created = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_research', arguments: question }),
      ),
    );
    expect(created.status).toBe('working');
    expect(created.pollIntervalMs).toBe(10);

    const done = await pollTask(client, created.taskId, (task) => task.status === 'completed');
    const result = CallToolResultSchema.parse(done.result);
    expect(result.content[0]?.text).toBe(ANSWER_NOW.answer);
    expect(result.structuredContent).toMatchObject({ outcome: 'ANSWERED', expert: 'research' });
    expect(done.result?.['resultType']).toBe('complete');
    expect(sandbox.closed).toHaveLength(1);
  });

  it('reports sandbox start-up through task status messages and honours tasks/cancel', async () => {
    const { client, sandbox } = await serve([hangingStep()]);
    const created = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_engineering', arguments: question }),
      ),
    );
    const triaging = await pollTask(
      client,
      created.taskId,
      (task) => task.statusMessage === 'Engineering Specialist started; triaging the request…',
    );
    expect(triaging.status).toBe('working');

    expectResult(await client.call('tasks/cancel', { taskId: created.taskId }));
    const cancelled = await pollTask(client, created.taskId, (task) => task.status === 'cancelled');
    expect(cancelled.status).toBe('cancelled');
    await waitUntil(() => sandbox.closed.length === 1);
  });

  it('completes the task with EXPERT_AGENT_DISPATCHED and lets expert_collect run as a task', async () => {
    const { client } = await serve([triageStep(DISPATCH), ...investigationSteps()], {
      sessions: () => shellSession(),
    });
    const created = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_research', arguments: question }),
      ),
    );
    const done = await pollTask(client, created.taskId, (task) => task.status === 'completed');
    const dispatched = CallToolResultSchema.parse(done.result);
    expect(dispatched.content[0]?.text?.split('\n')[0]).toBe('EXPERT_AGENT_DISPATCHED');
    expect(dispatched.structuredContent).toMatchObject({
      outcome: 'EXPERT_AGENT_DISPATCHED',
      nextTool: 'expert_collect',
    });
    const dispatchId = dispatched.structuredContent?.['dispatchId'] as string;
    expect(typeof dispatchId).toBe('string');

    const collectTask = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_collect', arguments: { dispatchId } }),
      ),
    );
    const collected = await pollTask(
      client,
      collectTask.taskId,
      (task) => task.status === 'completed',
    );
    const report = CallToolResultSchema.parse(collected.result);
    expect(report.content[0]?.text).toBe(REPORT);
    expect(report.structuredContent).toMatchObject({ status: 'completed', expert: 'research' });

    const status = CallToolResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_status', arguments: { dispatchId } }),
      ),
    );
    expect(status.structuredContent).toMatchObject({ status: 'completed' });
    expect((status.structuredContent?.['statusLog'] as string[]).at(-1)).toBe('Report ready');
  });

  it('fails the task when the expert errors and reports unknown ids with -32602', async () => {
    const { client } = await serve([]);
    const created = CreateTaskResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_logistics', arguments: question }),
      ),
    );
    const failed = await pollTask(client, created.taskId, (task) => task.status === 'failed');
    expect(failed.error?.code).toBe(-32_603);
    expect(failed.error?.message).toMatch(/^Expert consultation failed: /);
    expect(expectError(await client.call('tasks/get', { taskId: 'missing' })).code).toBe(-32_602);
  });

  it('serves non-task clients inline on the same endpoint', async () => {
    const { client } = await serve([triageStep(ANSWER_NOW)]);
    const result = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_research', arguments: question },
          { tasks: false },
        ),
      ),
    );
    expect(result.content[0]?.text).toBe(ANSWER_NOW.answer);
    expect(
      expectError(await client.call('tasks/get', { taskId: 'x' }, { tasks: false })).code,
    ).toBe(-32_021);
  });
});
