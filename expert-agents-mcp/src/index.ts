import { Runner } from '@openai/agents';
import { loadConfig } from './config.js';
import { getErrorMessage } from './errors.js';
import { DockerSandboxProvider } from './experts/sandbox.js';
import type { SandboxProvider } from './experts/sandbox.js';
import { ScriptedSandboxProvider } from './experts/scripted-sandbox.js';
import { LocalWorkspaceProvider } from './experts/local-workspace.js';
import { startHttpServer } from './http.js';
import { createExpertRuntime } from './server.js';

const log = (message: string): void => {
  process.stderr.write(`[expert-agents-mcp] ${message}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.hasOpenAIKey && config.sandbox !== 'scripted') {
    throw new Error('OPENAI_API_KEY is required (or set EXPERT_SANDBOX=scripted for a dry run)');
  }
  if (config.allowNonLoopback && !config.requiresToken) {
    throw new Error('EXPERT_MCP_TOKEN is required when exposing the MCP server publicly');
  }

  const sandbox: SandboxProvider =
    config.sandbox === 'docker'
      ? new DockerSandboxProvider({
          image: config.dockerImage,
          network: config.sandboxNetwork,
          log,
        })
      : config.sandbox === 'local'
        ? new LocalWorkspaceProvider()
        : new ScriptedSandboxProvider();
  log(`sandbox=${config.sandbox} model=${config.model} network=${config.sandboxNetwork}`);
  await sandbox.prepare();

  const runtime = createExpertRuntime({
    sandbox,
    runner: new Runner({ tracingDisabled: true }),
    model: config.model,
    taskTtlMs: config.taskTtlMs,
    pollIntervalMs: config.pollIntervalMs,
    dispatchTtlMs: config.dispatchTtlMs,
    maxConcurrent: config.maxConcurrent,
    log,
  });
  const handler = runtime.createHandler({
    onerror: (err) => log(`handler: ${getErrorMessage(err)}`),
  });
  const http = await startHttpServer({
    handler,
    host: config.host,
    port: config.port,
    requireToken: config.requiresToken,
    allowedHosts: config.publicHost ? [config.publicHost] : [],
    log,
  });
  log(`experts: ${runtime.experts.map((expert) => expert.id).join(', ')}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received; shutting down`);
    try {
      await http.close();
      await handler.close();
      await runtime.dispose();
    } catch (err) {
      log(`shutdown error: ${getErrorMessage(err)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log(`fatal: ${getErrorMessage(err)}`);
  process.exit(1);
});
