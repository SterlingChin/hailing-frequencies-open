import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Manifest, dir, file } from '@openai/agents/sandbox';
import type { SandboxSession } from '@openai/agents/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import type { SandboxNetwork } from '../config.js';
import type { ExpertInput } from './triage.js';

/**
 * The only module that spawns processes. Everything else talks to a `SandboxProvider`, so the
 * request handlers never touch Docker or child_process directly.
 */

const execFileAsync = promisify(execFile);
const OWNER_LABEL = 'expert-agents-mcp';
const DOCKER_TIMEOUT_MS = 5 * 60_000;

export interface SandboxProvider {
  readonly kind: 'local' | 'docker' | 'scripted';
  /** One-time readiness work (daemon check, image pull, orphan cleanup). */
  prepare(): Promise<void>;
  createSession(manifest: Manifest): Promise<SandboxSession>;
  /** Closes every session this provider still tracks. */
  dispose(): Promise<void>;
}

/** Scratch workspace: the request as files plus an empty out/ directory. No host paths. */
export function buildRequestManifest(input: ExpertInput): Manifest {
  const requestChildren: Record<string, ReturnType<typeof file>> = {
    'question.md': file({ content: input.question }),
  };
  if (input.context) requestChildren['context.md'] = file({ content: input.context });
  return new Manifest({
    entries: {
      request: dir({ children: requestChildren, description: 'The incoming request' }),
      out: dir({ description: 'Write artefacts here' }),
    },
  });
}

export interface DockerSandboxProviderOptions {
  image: string;
  network: SandboxNetwork;
  log?: (message: string) => void;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = 'docker' as const;
  readonly #client: DockerSandboxClient;
  readonly #image: string;
  readonly #log: (message: string) => void;
  readonly #open = new Set<SandboxSession>();

  constructor(options: DockerSandboxProviderOptions) {
    this.#image = options.image;
    this.#log = options.log ?? (() => {});
    this.#client = new DockerSandboxClient({
      image: options.image,
      labels: { [OWNER_LABEL]: 'true' },
      ...(options.network === 'none' && { networkMode: 'none' }),
    });
  }

  async prepare(): Promise<void> {
    await docker(['version', '--format', '{{.Server.Version}}']);
    this.#log(`pulling ${this.#image}`);
    await docker(['pull', '--quiet', this.#image]);
    const { stdout } = await docker(['ps', '-aq', '--filter', `label=${OWNER_LABEL}=true`]);
    const orphans = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (orphans.length > 0) {
      this.#log(`removing ${orphans.length} orphaned sandbox container(s)`);
      await docker(['rm', '-f', ...orphans]);
    }
  }

  async createSession(manifest: Manifest): Promise<SandboxSession> {
    const session = await this.#client.create({ manifest });
    this.#open.add(session);
    const close = session.close?.bind(session);
    session.close = async () => {
      this.#open.delete(session);
      await close?.();
    };
    return session;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#open];
    this.#open.clear();
    await Promise.allSettled(sessions.map((session) => session.close?.()));
  }
}

async function docker(args: readonly string[]): Promise<{ stdout: string }> {
  // Fixed binary, argument vector, no shell: nothing from a request reaches this call.
  const { stdout } = await execFileAsync('docker', [...args], {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return { stdout };
}
