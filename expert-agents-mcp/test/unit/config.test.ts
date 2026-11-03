import { afterEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('../../src/config.js');
}

describe('config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('applies defaults and exposes only non-secret fields', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const { loadConfig } = await load();
    const config = loadConfig();
    expect(config).toEqual({
      model: 'gpt-5.6-sol',
      host: '127.0.0.1',
      port: 8010,
      allowNonLoopback: false,
      publicHost: '',
      requiresToken: false,
      hasOpenAIKey: true,
      sandbox: 'scripted',
      dockerImage: 'python:3.14-slim',
      sandboxNetwork: 'none',
      taskTtlMs: 3_600_000,
      pollIntervalMs: 2000,
      dispatchTtlMs: 3_600_000,
      maxConcurrent: 3,
    });
    expect(JSON.stringify(config)).not.toContain('sk-test');
  });

  it('rejects non-loopback hosts unless explicitly allowed', async () => {
    vi.stubEnv('EXPERT_MCP_HOST', '0.0.0.0');
    let mod = await load();
    expect(() => mod.loadConfig()).toThrow(/loopback/);
    vi.stubEnv('EXPERT_MCP_ALLOW_NONLOOPBACK', 'true');
    mod = await load();
    expect(mod.loadConfig().host).toBe('0.0.0.0');
  });

  it('accepts local workspaces and Railway port and public hostname configuration', async () => {
    vi.stubEnv('EXPERT_SANDBOX', 'local');
    vi.stubEnv('EXPERT_MCP_PORT', '');
    vi.stubEnv('PORT', '8080');
    vi.stubEnv('RAILWAY_PUBLIC_DOMAIN', 'experts.up.railway.app');
    const { loadConfig } = await load();
    expect(loadConfig()).toMatchObject({
      sandbox: 'local',
      port: 8080,
      publicHost: 'experts.up.railway.app',
    });
  });

  it('validates enumerations and integers', async () => {
    vi.stubEnv('EXPERT_SANDBOX', 'cloud');
    const bad = await load();
    expect(() => bad.loadConfig()).toThrow(/EXPERT_SANDBOX/);
    vi.stubEnv('EXPERT_SANDBOX', 'docker');
    vi.stubEnv('EXPERT_MCP_PORT', 'eighty');
    const badPort = await load();
    expect(() => badPort.loadConfig()).toThrow(/EXPERT_MCP_PORT/);
  });

  it('compares bearer tokens in constant time and only when configured', async () => {
    let mod = await load();
    expect(mod.loadConfig().requiresToken).toBe(false);
    expect(mod.bearerTokenMatches(undefined)).toBe(true);

    vi.stubEnv('EXPERT_MCP_TOKEN', 'secret-token');
    mod = await load();
    expect(mod.loadConfig().requiresToken).toBe(true);
    expect(mod.bearerTokenMatches('secret-token')).toBe(true);
    expect(mod.bearerTokenMatches('secret-tokeN')).toBe(false);
    expect(mod.bearerTokenMatches('short')).toBe(false);
    expect(mod.bearerTokenMatches(undefined)).toBe(false);
  });
});
