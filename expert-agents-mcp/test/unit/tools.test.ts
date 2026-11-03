import { afterEach, describe, expect, it } from 'vitest';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import {
  ANSWER_NOW,
  DISPATCH,
  REPORT,
  buildTestRuntime,
  hangingStep,
  investigationSteps,
  shellSession,
  triageStep,
} from '../helpers/doubles.js';
import type { TestRuntime } from '../helpers/doubles.js';
import { CallToolResultSchema, WireClient, expectResult } from '../helpers/wire.js';

const INLINE = { tasks: false } as const;
const question = { question: 'Why is the tea cold?' };

describe('expert tools (inline path, no Tasks extension)', () => {
  const runtimes: TestRuntime[] = [];
  const handlers: McpHttpHandler[] = [];
  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.close();
    for (const { runtime } of runtimes.splice(0)) await runtime.dispose();
  });
  function setup(...args: Parameters<typeof buildTestRuntime>) {
    const built = buildTestRuntime(...args);
    runtimes.push(built);
    const handler = built.runtime.createHandler();
    handlers.push(handler);
    return { ...built, client: new WireClient((request) => handler.fetch(request)) };
  }

  it('lists one tool per expert plus the dispatch management tools', async () => {
    const { client } = setup([]);
    const result = expectResult(await client.call('tools/list', {}, INLINE));
    const names = (result['tools'] as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual([
      'expert_cancel',
      'expert_collect',
      'expert_engineering',
      'expert_logistics',
      'expert_research',
      'expert_status',
      'list_experts',
    ]);
    const list = CallToolResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'list_experts', arguments: {} }, INLINE),
      ),
    );
    expect((list.structuredContent?.['experts'] as unknown[]).length).toBe(3);
  });

  it('returns a direct answer inline when triage says answer_now', async () => {
    const { client, sandbox } = setup([triageStep(ANSWER_NOW)]);
    const result = CallToolResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_research', arguments: question }, INLINE),
      ),
    );
    expect(result.content[0]?.text).toBe(ANSWER_NOW.answer);
    expect(result.structuredContent).toMatchObject({ outcome: 'ANSWERED', expert: 'research' });
    expect(result.isError).toBeUndefined();
    expect(sandbox.closed).toHaveLength(1);
  });

  it('reports EXPERT_AGENT_DISPATCHED and lets the caller check, collect and cancel', async () => {
    const { client, runtime } = setup([triageStep(DISPATCH), hangingStep()]);
    const dispatched = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_engineering', arguments: question },
          INLINE,
        ),
      ),
    );
    expect(dispatched.content[0]?.text?.startsWith('EXPERT_AGENT_DISPATCHED')).toBe(true);
    const dispatchId = dispatched.structuredContent?.['dispatchId'] as string;
    expect(dispatched.structuredContent).toMatchObject({
      outcome: 'EXPERT_AGENT_DISPATCHED',
      expert: 'engineering',
      plan: DISPATCH.plan,
      nextTool: 'expert_collect',
    });

    const status = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_status', arguments: { dispatchId } },
          INLINE,
        ),
      ),
    );
    expect(status.structuredContent).toMatchObject({ status: 'working', expert: 'engineering' });

    const collect = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_collect', arguments: { dispatchId } },
          INLINE,
        ),
      ),
    );
    expect(collect.content[0]?.text?.startsWith('Still working')).toBe(true);

    const cancelled = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_cancel', arguments: { dispatchId } },
          INLINE,
        ),
      ),
    );
    expect(cancelled.structuredContent).toMatchObject({ status: 'cancelled' });
    expect(runtime.dispatch.status(dispatchId)?.status).toBe('cancelled');

    const afterCancel = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_collect', arguments: { dispatchId } },
          INLINE,
        ),
      ),
    );
    expect(afterCancel.isError).toBe(true);
  });

  it('collects the finished report inline', async () => {
    const { client, runtime } = setup([triageStep(DISPATCH), ...investigationSteps()], {
      sessions: () => shellSession(),
    });
    const dispatched = CallToolResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_research', arguments: question }, INLINE),
      ),
    );
    const dispatchId = dispatched.structuredContent?.['dispatchId'] as string;
    await runtime.dispatch.waitFor(dispatchId);
    const collect = CallToolResultSchema.parse(
      expectResult(
        await client.call(
          'tools/call',
          { name: 'expert_collect', arguments: { dispatchId } },
          INLINE,
        ),
      ),
    );
    expect(collect.content[0]?.text).toBe(REPORT);
    expect(collect.structuredContent).toMatchObject({ status: 'completed', report: REPORT });
  });

  it('answers unknown dispatch ids with a tool error, never a protocol error', async () => {
    const { client } = setup([]);
    for (const name of ['expert_status', 'expert_collect', 'expert_cancel']) {
      const result = CallToolResultSchema.parse(
        expectResult(
          await client.call('tools/call', { name, arguments: { dispatchId: 'nope' } }, INLINE),
        ),
      );
      expect(result.isError).toBe(true);
    }
  });

  it('turns a failing consultation into a tool error with a short message', async () => {
    const { client } = setup([]);
    const result = CallToolResultSchema.parse(
      expectResult(
        await client.call('tools/call', { name: 'expert_logistics', arguments: question }, INLINE),
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Expert consultation failed: /);
  });
});
