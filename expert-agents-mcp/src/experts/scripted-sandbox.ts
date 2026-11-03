import type { Editor } from '@openai/agents';
import { Manifest } from '@openai/agents/sandbox';
import type { SandboxSession, SandboxSessionState } from '@openai/agents/sandbox';
import type { SandboxProvider } from './sandbox.js';

export type SessionFactory = (manifest: Manifest) => SandboxSession;

/**
 * Sandbox session that executes nothing. It satisfies the shell and filesystem capability checks
 * (`execCommand`, `createEditor`) so agents can be constructed, and every command returns a note
 * saying the sandbox is scripted. Used for `EXPERT_SANDBOX=scripted` dry runs and as a test base.
 */
export class NoopSandboxSession implements SandboxSession {
  state: SandboxSessionState;
  readonly commands: string[] = [];
  closed = false;

  constructor(manifest: Manifest = new Manifest()) {
    this.state = { manifest, workspaceReady: true };
  }

  async applyManifest(): Promise<void> {}

  async execCommand(args: { cmd: string }): Promise<string> {
    this.commands.push(args.cmd);
    return 'scripted sandbox: command not executed';
  }

  createEditor(): Editor {
    const done = async () => ({ status: 'completed' as const, output: 'scripted sandbox: no-op' });
    return { createFile: done, updateFile: done, deleteFile: done };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * In-memory sandbox for tests and for `EXPERT_SANDBOX=scripted`. Each session comes from the factory
 * (default: `NoopSandboxSession`) and is tracked so tests can assert that sessions were closed.
 */
export class ScriptedSandboxProvider implements SandboxProvider {
  readonly kind = 'scripted' as const;
  readonly created: SandboxSession[] = [];
  readonly closed: SandboxSession[] = [];
  readonly #factory: SessionFactory;
  #prepared = false;

  constructor(factory: SessionFactory = () => new NoopSandboxSession()) {
    this.#factory = factory;
  }

  get prepared(): boolean {
    return this.#prepared;
  }

  async prepare(): Promise<void> {
    this.#prepared = true;
  }

  async createSession(manifest: Manifest): Promise<SandboxSession> {
    const session = this.#factory(manifest);
    const close = session.close?.bind(session);
    session.close = async () => {
      if (!this.closed.includes(session)) this.closed.push(session);
      await close?.();
    };
    this.created.push(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.created) {
      if (!this.closed.includes(session)) await session.close?.();
    }
  }
}
