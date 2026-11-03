import './environment.js';

// Every environment variable is read exactly once into a module constant. Secrets are exposed only
// as booleans; the OpenAI key stays in process.env where the Agents SDK reads it itself.
// OX Agent: javascript-server-hardening prevented (env read once at top of module, never attached to objects)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const EXPERT_MODEL = process.env.EXPERT_MODEL ?? 'gpt-5.6-sol';
const EXPERT_MCP_HOST = process.env.EXPERT_MCP_HOST ?? '127.0.0.1';
const EXPERT_MCP_PORT = process.env.EXPERT_MCP_PORT || process.env.PORT || '8010';
const EXPERT_MCP_PUBLIC_HOST =
  process.env.EXPERT_MCP_PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || '';
const EXPERT_MCP_ALLOW_NONLOOPBACK = process.env.EXPERT_MCP_ALLOW_NONLOOPBACK ?? 'false';
const EXPERT_MCP_TOKEN = process.env.EXPERT_MCP_TOKEN ?? '';
const EXPERT_SANDBOX = process.env.EXPERT_SANDBOX ?? 'local';
const EXPERT_DOCKER_IMAGE = process.env.EXPERT_DOCKER_IMAGE ?? 'python:3.14-slim';
const EXPERT_SANDBOX_NETWORK = process.env.EXPERT_SANDBOX_NETWORK ?? 'none';
const EXPERT_TASK_TTL_MS = process.env.EXPERT_TASK_TTL_MS ?? '3600000';
const EXPERT_POLL_INTERVAL_MS = process.env.EXPERT_POLL_INTERVAL_MS ?? '2000';
const EXPERT_DISPATCH_TTL_MS = process.env.EXPERT_DISPATCH_TTL_MS ?? '3600000';
const EXPERT_MAX_CONCURRENT = process.env.EXPERT_MAX_CONCURRENT ?? '3';

export type SandboxKind = 'local' | 'docker' | 'scripted';
export type SandboxNetwork = 'none' | 'default';

export interface AppConfig {
  readonly model: string;
  readonly host: string;
  readonly port: number;
  readonly allowNonLoopback: boolean;
  readonly publicHost: string;
  readonly requiresToken: boolean;
  readonly hasOpenAIKey: boolean;
  readonly sandbox: SandboxKind;
  readonly dockerImage: string;
  readonly sandboxNetwork: SandboxNetwork;
  readonly taskTtlMs: number;
  readonly pollIntervalMs: number;
  readonly dispatchTtlMs: number;
  readonly maxConcurrent: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function positiveInt(name: string, raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function oneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
}

function parseBoolean(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true';
}

/** Validated, non-secret configuration. Safe to log and to return from health endpoints. */
export function loadConfig(): AppConfig {
  const allowNonLoopback = parseBoolean(EXPERT_MCP_ALLOW_NONLOOPBACK);
  const host = EXPERT_MCP_HOST.trim() || '127.0.0.1';
  if (!allowNonLoopback && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'EXPERT_MCP_HOST must be a loopback address unless EXPERT_MCP_ALLOW_NONLOOPBACK=true',
    );
  }
  return {
    model: EXPERT_MODEL.trim() || 'gpt-5.6-sol',
    host,
    port: positiveInt('EXPERT_MCP_PORT', EXPERT_MCP_PORT),
    allowNonLoopback,
    publicHost: EXPERT_MCP_PUBLIC_HOST.trim(),
    requiresToken: EXPERT_MCP_TOKEN.length > 0,
    hasOpenAIKey: OPENAI_API_KEY.length > 0,
    sandbox: oneOf('EXPERT_SANDBOX', EXPERT_SANDBOX, ['local', 'docker', 'scripted'] as const),
    dockerImage: EXPERT_DOCKER_IMAGE.trim() || 'python:3.14-slim',
    sandboxNetwork: oneOf('EXPERT_SANDBOX_NETWORK', EXPERT_SANDBOX_NETWORK, [
      'none',
      'default',
    ] as const),
    taskTtlMs: positiveInt('EXPERT_TASK_TTL_MS', EXPERT_TASK_TTL_MS),
    pollIntervalMs: positiveInt('EXPERT_POLL_INTERVAL_MS', EXPERT_POLL_INTERVAL_MS),
    dispatchTtlMs: positiveInt('EXPERT_DISPATCH_TTL_MS', EXPERT_DISPATCH_TTL_MS),
    maxConcurrent: positiveInt('EXPERT_MAX_CONCURRENT', EXPERT_MAX_CONCURRENT),
  };
}

/**
 * Compares a presented bearer token with the configured one in constant time. Returns true when
 * no token is configured. The configured value never leaves this module.
 */
// OX Agent: javascript-server-hardening prevented (secret compared in constant time, never exposed)
export function bearerTokenMatches(presented: string | undefined): boolean {
  if (EXPERT_MCP_TOKEN.length === 0) return true;
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(EXPERT_MCP_TOKEN, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
  return diff === 0;
}
