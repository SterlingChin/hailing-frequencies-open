import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { applyDiff } from '@openai/agents';
import type { Editor } from '@openai/agents';
import { Manifest } from '@openai/agents/sandbox';
import type {
  ExecCommandArgs,
  SandboxExecResult,
  SandboxSessionState,
} from '@openai/agents/sandbox';
import type { SandboxProvider } from './sandbox.js';

export interface LocalWorkspaceOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}

/** Scratch directories and process lifecycle management; not an OS security sandbox. */
export class LocalWorkspaceProvider implements SandboxProvider {
  readonly kind = 'local' as const;
  readonly #sessions = new Set<LocalWorkspaceSession>();
  readonly #options: LocalWorkspaceOptions;
  #disposed = false;

  constructor(options: LocalWorkspaceOptions = {}) {
    this.#options = options;
  }

  async prepare(): Promise<void> {
    if (process.platform === 'win32') throw new Error('Local workspaces require a POSIX host');
  }

  async createSession(manifest: Manifest): Promise<LocalWorkspaceSession> {
    if (this.#disposed) throw new Error('Workspace provider is closed');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'expert-workspace-')));
    const session = new LocalWorkspaceSession(root, manifest, this.#options, () => {
      this.#sessions.delete(session);
    });
    this.#sessions.add(session);
    try {
      await session.applyManifest(session.state.manifest);
      // Disposal can race asynchronous materialization.
      if (this.#disposed) throw new Error('Workspace provider is closed');
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }
}

export class LocalWorkspaceSession {
  readonly state: SandboxSessionState;
  readonly #root: string;
  readonly #timeout: number;
  readonly #maxBytes: number;
  readonly #onClose: () => void;
  readonly #commands = new Map<number, { kill: () => void; done: Promise<SandboxExecResult> }>();
  #closed = false;
  #closing?: Promise<void>;

  constructor(
    root: string,
    manifest: Manifest,
    options: LocalWorkspaceOptions,
    onClose: () => void,
  ) {
    this.#root = root;
    this.#timeout = options.commandTimeoutMs ?? 60_000;
    this.#maxBytes = options.maxOutputBytes ?? 256 * 1024;
    this.#onClose = onClose;
    this.state = {
      manifest: new Manifest({ root, entries: manifest.entries }),
      workspaceReady: false,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Workspace session is closed');
  }

  /** Check both lexical traversal and existing symlinks for filesystem tool paths. */
  async #path(path: string): Promise<string> {
    this.#assertOpen();
    const target = resolve(this.#root, path);
    const inside = (candidate: string): boolean => {
      const rel = relative(this.#root, candidate);
      return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
    };
    if (!inside(target)) throw new Error('Path must remain inside the workspace');
    let ancestor = target;
    for (;;) {
      try {
        if (!inside(await realpath(ancestor)))
          throw new Error('Path must remain inside the workspace');
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  async applyManifest(manifest: Manifest): Promise<void> {
    for (const { logicalPath, entry } of manifest.iterEntries()) {
      const target = await this.#path(logicalPath);
      if (entry.type === 'dir') await mkdir(target, { recursive: true });
      else if (entry.type === 'file') {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.content);
      } else throw new Error(`Unsupported local workspace entry: ${entry.type}`);
    }
    this.state.workspaceReady = true;
  }

  async readFile(args: { path: string; maxBytes?: number }): Promise<string> {
    const target = await this.#path(args.path);
    // Bound reads even when an agent has created a very large file.
    const { open } = await import('node:fs/promises');
    const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile())
        throw new Error('Workspace reads require a regular file');
      const buffer = Buffer.alloc(Math.min(args.maxBytes ?? this.#maxBytes, this.#maxBytes));
      const { bytesRead } = await handle.read(buffer);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async pathExists(path: string): Promise<boolean> {
    const target = await this.#path(path);
    try {
      await access(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  createEditor(): Editor {
    return {
      createFile: async ({ path, diff }) => {
        const target = await this.#path(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, applyDiff('', diff, 'create'), { flag: 'wx' });
        return { status: 'completed' };
      },
      updateFile: async ({ path, diff }) => {
        const target = await this.#path(path);
        const content = await this.readFile({ path });
        // Do not silently patch truncated content.
        if (Buffer.byteLength(content) >= this.#maxBytes)
          throw new Error('File exceeds patch size limit');
        await writeFile(target, applyDiff(content, diff));
        return { status: 'completed' };
      },
      deleteFile: async ({ path }) => {
        await rm(await this.#path(path));
        return { status: 'completed' };
      },
    };
  }

  supportsPty(): boolean {
    return false;
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    this.#assertOpen();
    if (args.tty) throw new Error('Local workspaces do not support PTY commands');
    if (args.runAs) throw new Error('Local workspaces do not support runAs');
    const cwd = await this.#path(args.workdir ?? '.');
    this.#assertOpen();
    const started = Date.now();
    // Deliberate allowlist: no process.env spread, shell profiles, or inherited credentials.
    const child = spawn('/bin/sh', ['-c', args.cmd], {
      cwd,
      detached: true,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: this.#root,
        TMPDIR: this.#root,
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let reason = '';
    const maxBytes = Math.min(
      this.#maxBytes,
      Math.max(1, args.maxOutputTokens ?? this.#maxBytes) * 4,
    );
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const bounded = chunk.subarray(0, Math.max(0, maxBytes - bytes)).toString('utf8');
      if (stream === 'stdout') stdout += bounded;
      else stderr += bounded;
      bytes += chunk.length;
      if (bytes > maxBytes && !reason) {
        reason = 'Command exceeded output limit';
        kill();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
    const done = new Promise<SandboxExecResult>((resolveDone, reject) => {
      const timer = setTimeout(() => {
        reason = 'Command timed out';
        kill();
      }, this.#timeout);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', kill);
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        // Also clean up background children left by an exited shell.
        kill();
        resolveDone({
          stdout,
          stderr,
          output: [stdout, stderr, reason].filter(Boolean).join('\n'),
          exitCode,
          wallTimeSeconds: (Date.now() - started) / 1000,
        });
      });
    });
    if (child.pid) this.#commands.set(child.pid, { kill, done });
    try {
      return await done;
    } finally {
      if (child.pid) this.#commands.delete(child.pid);
    }
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    const result = await this.exec(args);
    return `${result.output}\nExit code: ${result.exitCode ?? 'terminated'}`;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      const running = [...this.#commands.values()];
      for (const command of running) command.kill();
      await Promise.allSettled(running.map((command) => command.done));
      await rm(this.#root, { recursive: true, force: true });
      this.#onClose();
    })();
    return this.#closing;
  }
}
