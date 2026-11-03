import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { CreateMcpHandlerOptions, McpHttpHandler } from '@modelcontextprotocol/server';
import type { Runner } from '@openai/agents';
import type { Model } from '@openai/agents';
import { ExpertDispatchService } from './experts/dispatch.js';
import { EXPERTS } from './experts/registry.js';
import type { ExpertDefinition } from './experts/registry.js';
import type { SandboxProvider } from './experts/sandbox.js';
import { InMemoryTaskStore } from './tasks/in-memory-store.js';
import { TasksExtension } from './tasks/tasks-extension.js';
import { registerExpertTools } from './tools/index.js';

export const SERVER_INFO = { name: 'expert-agents-mcp', version: '0.1.0' } as const;

const INSTRUCTIONS = `Expert Agent server. Call an expert_* tool with your question. The expert triages it inside a sandbox and either answers directly or replies EXPERT_AGENT_DISPATCHED with a dispatchId; in that case keep working on your own task and call expert_collect (or expert_status) later. Clients that declare the MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28) receive a task to poll while the sandbox starts.`;

export interface ExpertServerDependencies {
  sandbox: SandboxProvider;
  runner: Runner;
  model: string | Model;
  experts?: readonly ExpertDefinition[];
  taskTtlMs: number;
  pollIntervalMs: number;
  dispatchTtlMs: number;
  maxConcurrent: number;
  log?: (message: string) => void;
}

export interface ExpertServerRuntime {
  store: InMemoryTaskStore;
  tasks: TasksExtension;
  dispatch: ExpertDispatchService;
  experts: readonly ExpertDefinition[];
  /** Builds a fresh McpServer bound to the shared runtime; createMcpHandler calls it per request. */
  buildMcpServer(): McpServer;
  createHandler(
    options?: Pick<CreateMcpHandlerOptions, 'responseMode' | 'onerror'>,
  ): McpHttpHandler;
  dispose(): Promise<void>;
}

/** Wires the long-lived pieces (stores, dispatch service) that must outlive per-request servers. */
export function createExpertRuntime(deps: ExpertServerDependencies): ExpertServerRuntime {
  const store = new InMemoryTaskStore();
  const tasks = new TasksExtension(store, {
    defaultTtlMs: deps.taskTtlMs,
    defaultPollIntervalMs: deps.pollIntervalMs,
  });
  const dispatch = new ExpertDispatchService({
    sandbox: deps.sandbox,
    runner: deps.runner,
    model: deps.model,
    maxConcurrent: deps.maxConcurrent,
    dispatchTtlMs: deps.dispatchTtlMs,
    ...(deps.log && { log: deps.log }),
  });
  const experts = deps.experts ?? EXPERTS;

  const buildMcpServer = (): McpServer => {
    const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    // Both must precede the first registerTool (the SDK freezes custom handlers lazily).
    tasks.advertise(mcp.server);
    tasks.install(mcp.server);
    registerExpertTools(mcp, {
      tasks,
      store,
      dispatch,
      experts,
      taskTtlMs: deps.taskTtlMs,
      pollIntervalMs: deps.pollIntervalMs,
      ...(deps.log && { log: deps.log }),
    });
    return mcp;
  };

  return {
    store,
    tasks,
    dispatch,
    experts,
    buildMcpServer,
    createHandler: (options = {}) =>
      createMcpHandler(() => buildMcpServer(), { legacy: 'reject', ...options }),
    dispose: async () => {
      await dispatch.dispose();
      await deps.sandbox.dispose();
      store.close();
    },
  };
}
