import { describe, expect, it, vi } from 'vitest';
import { InMemoryTaskStore } from '../../src/tasks/in-memory-store.js';

describe('InMemoryTaskStore', () => {
  it('creates working tasks and walks them to completed with status messages', async () => {
    const store = new InMemoryTaskStore({ createTaskId: () => 't1' });
    const task = await store.create({ ttlMs: 60_000, pollIntervalMs: 500 });
    expect(task).toMatchObject({
      taskId: 't1',
      status: 'working',
      ttlMs: 60_000,
      pollIntervalMs: 500,
    });

    const handle = store.handle('t1');
    await handle.status('Starting sandbox');
    expect(await store.get('t1')).toMatchObject({
      status: 'working',
      statusMessage: 'Starting sandbox',
    });

    await handle.complete({ content: [{ type: 'text', text: 'done' }] });
    const detailed = await store.get('t1');
    expect(detailed?.status).toBe('completed');
    if (detailed?.status === 'completed') {
      expect(detailed.result).toEqual({
        resultType: 'complete',
        content: [{ type: 'text', text: 'done' }],
      });
    }
    // Writes after a terminal state are ignored.
    await handle.status('late');
    expect((await store.get('t1'))?.statusMessage).toBe('Completed');
    store.close();
  });

  it('records failures with a generic error object', async () => {
    const store = new InMemoryTaskStore({ createTaskId: () => 't2' });
    await store.create({ ttlMs: null });
    await store.handle('t2').fail({ code: -32_603, message: 'Expert failed' });
    const detailed = await store.get('t2');
    expect(detailed).toMatchObject({
      status: 'failed',
      error: { code: -32_603, message: 'Expert failed' },
    });
    store.close();
  });

  it('cancel aborts the worker signal, is idempotent and wins over late completion', async () => {
    const store = new InMemoryTaskStore({ createTaskId: () => 't3' });
    await store.create({ ttlMs: null });
    const handle = store.handle('t3');
    const aborted = vi.fn();
    handle.signal.addEventListener('abort', aborted);

    expect(await store.cancel('t3')).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(await store.cancel('t3')).toBe(true);
    await handle.complete({ content: [] });
    expect((await store.get('t3'))?.status).toBe('cancelled');
    expect(await store.cancel('missing')).toBe(false);
    store.close();
  });

  it('isolates tasks by principal without leaking existence', async () => {
    const store = new InMemoryTaskStore({ createTaskId: () => 't4' });
    await store.create({ ttlMs: null, principal: 'alice' });
    expect(await store.get('t4', { principal: 'bob' })).toBeUndefined();
    expect(await store.get('t4')).toBeUndefined();
    expect(await store.get('t4', { principal: 'alice' })).toMatchObject({ status: 'working' });
    store.close();
  });

  it('supports input_required round trips and lists only unanswered requests', async () => {
    const store = new InMemoryTaskStore({ createTaskId: () => 't5' });
    await store.create({ ttlMs: null });
    const handle = store.handle('t5');
    const answers = handle.requireInput({
      a: { method: 'elicitation/create' },
      b: { method: 'x' },
    });
    expect(await store.get('t5')).toMatchObject({ status: 'input_required' });

    await store.update('t5', { a: { action: 'accept' } });
    const partial = await store.get('t5');
    if (partial?.status === 'input_required')
      expect(Object.keys(partial.inputRequests)).toEqual(['b']);

    await store.update('t5', { b: { action: 'decline' }, ignored: 1 });
    expect(await answers).toEqual({ a: { action: 'accept' }, b: { action: 'decline' } });
    expect(await store.get('t5')).toMatchObject({ status: 'working' });
    store.close();
  });

  it('purges tasks after their ttl', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryTaskStore({ createTaskId: () => 't6' });
      await store.create({ ttlMs: 1000 });
      expect(await store.get('t6')).toBeDefined();
      vi.advanceTimersByTime(1001);
      expect(await store.get('t6')).toBeUndefined();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
