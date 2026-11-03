import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRequestManifest } from '../../src/experts/sandbox.js';
import { LocalWorkspaceProvider } from '../../src/experts/local-workspace.js';
import { functionCall } from '@openai/agents/testing';
import { findExpert } from '../../src/experts/registry.js';
import { buildTestRuntime, DISPATCH, triageStep } from '../helpers/doubles.js';

const providers: LocalWorkspaceProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
  vi.unstubAllEnvs();
});

async function session(options = {}) {
  const provider = new LocalWorkspaceProvider(options);
  providers.push(provider);
  await provider.prepare();
  return provider.createSession(
    buildRequestManifest({ question: 'Analyze this', context: 'data' }),
  );
}

it('materializes separate workspaces and executes commands without inherited secrets', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'secret-test-value');
  const first = await session();
  const second = await session();
  expect(first.state.manifest.root).not.toBe(second.state.manifest.root);
  expect(await readFile(join(first.state.manifest.root, 'request/question.md'), 'utf8')).toBe(
    'Analyze this',
  );
  const result = await first.exec({
    cmd: 'cat request/context.md; printf "|%s" "$OPENAI_API_KEY"; printf report > out/report.txt',
  });
  expect(result.stdout).toBe('data|');
  expect(result.exitCode).toBe(0);
  expect(await first.readFile({ path: 'out/report.txt' })).toBe('report');
  await expect(second.readFile({ path: 'out/report.txt' })).rejects.toThrow();
});

it('applies real file patches and rejects paths outside the workspace, including symlinks', async () => {
  const s = await session();
  const editor = s.createEditor();
  await editor.createFile({ type: 'create_file', path: 'out/result.txt', diff: '+before' });
  await editor.updateFile({
    type: 'update_file',
    path: 'out/result.txt',
    diff: '@@\n-before\n+after',
  });
  expect(await s.readFile({ path: 'out/result.txt' })).toContain('after');
  await expect(s.readFile({ path: '../outside' })).rejects.toThrow(/workspace/);
  await symlink('/tmp', join(s.state.manifest.root, 'out/link'));
  await expect(
    editor.createFile({ type: 'create_file', path: 'out/link/escape.txt', diff: '+bad' }),
  ).rejects.toThrow(/workspace/);
  await editor.deleteFile({ type: 'delete_file', path: 'out/result.txt' });
  await expect(s.readFile({ path: 'out/result.txt' })).rejects.toThrow();
});

it('kills timed-out commands and bounds captured output', async () => {
  const s = await session({ commandTimeoutMs: 100, maxOutputBytes: 128 });
  const result = await s.exec({ cmd: 'sleep 30' });
  expect(result.output).toMatch(/timed out/);
  const flood = await s.exec({ cmd: 'yes output' });
  expect(flood.output).toMatch(/output limit/);
  expect(flood.stdout.length).toBeLessThanOrEqual(128);
});

it('closing a session kills running commands, removes files, and prevents reuse', async () => {
  const s = await session();
  const running = s.exec({
    cmd: 'printf started > out/started; sleep 30; printf leaked > out/leaked',
  });
  for (let i = 0; i < 100; i++) {
    if (await s.pathExists('out/started')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await s.pathExists('out/started')).toBe(true);
  await s.close();
  await running;
  await expect(access(s.state.manifest.root)).rejects.toThrow();
  await expect(s.exec({ cmd: 'echo bad' })).rejects.toThrow(/closed/);
});

it('finishes a shell promptly even when it leaves background children holding output pipes', async () => {
  const s = await session();
  const result = await Promise.race([
    s.exec({ cmd: 'sleep 30 &' }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Background pipe stayed open')), 500),
    ),
  ]);
  expect(result.exitCode).toBe(0);
});

it('rejects named pipes instead of blocking filesystem reads', async () => {
  const s = await session();
  await s.exec({ cmd: 'mkfifo out/pipe' });
  await expect(
    Promise.race([
      s.readFile({ path: 'out/pipe' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Read blocked')), 500)),
    ]),
  ).rejects.toThrow(/regular file/);
});

it('dispatch cancellation interrupts a real shell command before its timeout', async () => {
  const s = await session();
  const provider = {
    kind: 'local' as const,
    prepare: async () => {},
    createSession: async () => s,
    dispose: () => s.close(),
  };
  const { runtime } = buildTestRuntime(
    [
      triageStep(DISPATCH),
      [
        functionCall(
          'exec_command',
          { cmd: 'printf started > out/running; sleep 30' },
          { callId: 'running_cmd' },
        ),
      ],
    ],
    { sandbox: provider },
  );
  try {
    const outcome = await runtime.dispatch.consult(
      findExpert('research')!,
      { question: 'test' },
      {
        signal: new AbortController().signal,
        status: async () => {},
      },
    );
    if (outcome.kind !== 'dispatched') throw new Error('Expected dispatch');
    for (let i = 0; i < 100 && !(await s.pathExists('out/running')); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await s.pathExists('out/running')).toBe(true);
    await Promise.race([
      runtime.dispatch.cancel(outcome.dispatchId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Cancellation did not stop command')), 500),
      ),
    ]);
    await expect(access(s.state.manifest.root)).rejects.toThrow();
    expect(runtime.dispatch.status(outcome.dispatchId)?.status).toBe('cancelled');
  } finally {
    await s.close();
    await runtime.dispose();
  }
});
