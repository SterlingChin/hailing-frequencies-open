# Expert Agent MCP server

A standalone TypeScript [MCP](https://modelcontextprotocol.io) server that exposes **Expert Agent**
tools. Each tool hands your question to an OpenAI agent running in a **temporary local workspace**. The
agent triages the request and either answers right away or replies `EXPERT_AGENT_DISPATCHED` and
keeps investigating in the background while you carry on; you collect the report later.

Progress is reported through the **MCP Tasks extension** (`io.modelcontextprotocol/tasks`, schema
revision 2026-07-28): a tool call returns a task, the task's status messages show the sandbox
starting up and the agent triaging, and the task completes with the answer or the dispatch marker.

```
caller ──tools/call expert_research──▶ task {working: "Starting sandbox for Research Analyst…"}
       ◀─tasks/get ─────────────────── {working: "Research Analyst started; triaging the request…"}
       ◀─tasks/get ─────────────────── {completed: result = answer
                                                   | "EXPERT_AGENT_DISPATCHED" + dispatchId}
caller ──tools/call expert_collect {dispatchId}──▶ task mirroring the investigation → report
```

## Requirements

- Node.js 22 or newer (`.nvmrc` pins 26.0.0), npm, public npm registry (`.npmrc` pins it).
- A POSIX host with `/bin/sh`; Python 3 is included in the Railway runtime.
- Docker CLI + daemon only if explicitly selecting the optional Docker backend.
- An OpenAI API key for live runs. Tests need neither Docker nor a key.

## Quick start

```bash
cd mcp
npm ci
cp .env.example .env            # set OPENAI_API_KEY
npm run dev                      # listens on http://127.0.0.1:8010/mcp
```

Point an MCP client that speaks protocol revision 2026-07-28 at `http://127.0.0.1:8010/mcp`.
Clients that also declare the Tasks extension get tasks; other clients get the same tools with
inline results (the call blocks until triage finishes).

`GET /healthz` answers `{"ok":true}`. Everything else outside `/mcp` is a 404.

### Dry run without Docker or a key

```bash
EXPERT_SANDBOX=scripted npm run dev
```

The server starts with an inert sandbox (commands are not executed). Model calls still need a key,
so this mode is mostly for checking wiring and client connectivity.

## Tools

| Tool | Purpose |
| --- | --- |
| `expert_research`, `expert_engineering`, `expert_logistics` | Consult an expert. Args: `question` (required), `context` (optional text; saved as `request/context.md` in the sandbox). |
| `expert_collect` | Wait for a dispatched investigation and return its report. Task-capable. |
| `expert_status` | Current status and recent activity of a dispatch, without waiting. |
| `expert_cancel` | Abort a dispatch and remove its container. |
| `list_experts` | Enumerate experts and their tool names. |

Every expert result carries `structuredContent.outcome`:

- `ANSWERED` with `answer` and `summary`.
- `EXPERT_AGENT_DISPATCHED` with `dispatchId`, `summary`, `plan`, `nextTool: "expert_collect"`.
  The text content starts with the literal line `EXPERT_AGENT_DISPATCHED`.
- `CAPACITY` (`isError: true`) when the expert wanted to investigate but `EXPERT_MAX_CONCURRENT`
  slots are busy.

A failed consultation fails the task (`-32603`, message prefixed `Expert consultation failed:`), or
returns an `isError` result on the inline path. Cancelling the task (`tasks/cancel`) aborts triage
and closes the sandbox.

## Configuration

All settings come from the environment (`.env` is loaded from `mcp/`; `EXPERT_ENV_FILE=` disables).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | – | Read by the OpenAI Agents SDK. Required unless `EXPERT_SANDBOX=scripted`. |
| `EXPERT_MODEL` | `gpt-5.6-sol` | Model for triage (reasoning effort low) and investigation (medium). |
| `EXPERT_MCP_HOST` / `EXPERT_MCP_PORT` | `127.0.0.1` / `PORT` or `8010` | Listener. Non-loopback hosts need `EXPERT_MCP_ALLOW_NONLOOPBACK=true`. |
| `EXPERT_MCP_PUBLIC_HOST` | `RAILWAY_PUBLIC_DOMAIN` or empty | Allowed public request hostname. |
| `EXPERT_MCP_TOKEN` | empty | If set, requests must send `Authorization: Bearer <token>`. |
| `EXPERT_SANDBOX` | `local` | `local`, optional `docker`, or inert `scripted`. |
| `EXPERT_DOCKER_IMAGE` | `python:3.14-slim` | Pulled at start-up. |
| `EXPERT_SANDBOX_NETWORK` | `none` | `none` (no network in the container) or `default`. |
| `EXPERT_TASK_TTL_MS` / `EXPERT_POLL_INTERVAL_MS` | `3600000` / `2000` | Task lifetime and suggested poll interval. |
| `EXPERT_DISPATCH_TTL_MS` | `3600000` | How long a finished dispatch stays collectable. |
| `EXPERT_MAX_CONCURRENT` | `3` | Parallel background investigations. |

## How it works

- **Tasks extension by hand.** `@modelcontextprotocol/server` 2.3.1 has no server-side tasks yet
  (that lands in a future `ext/tasks` subpath). `src/tasks/` implements the 2026-07-28 shapes:
  `tasks/get`, `tasks/update`, `tasks/cancel` handlers, an in-memory `TaskStore` with worker
  `TaskHandle`s, `-32021` for clients that do not declare the extension, `-32602` for unknown ids,
  and `resultType: "task"` passthrough on `tools/call`. The API mirrors the upcoming official one so
  swapping is mechanical. Notifications are not pushed; clients poll `tasks/get`.
- **Workspace.** `@openai/agents` `SandboxAgent` with a local workspace session. Triage and
  investigation share a fresh temporary directory containing `request/` and `out/`. Commands run
  through `/bin/sh` with a minimal environment (no inherited API keys), a 60-second timeout and
  256 KiB output limit. File tools reject traversal and symlinks outside the workspace. Closing a
  session kills its process groups and removes its directory. This is workspace separation,
  not OS isolation: shell commands retain the service user's filesystem and network permissions,
  and can access other workspaces or server files. CPU, memory and disk are shared. Do not expose
  it to untrusted callers. The Docker backend remains opt-in for hosts with a Docker daemon.
- **Security.** Loopback bind with Host/Origin validation, optional bearer token (constant-time
  compare), env read once into constants, generic error messages, explicit result projections,
  `child_process` confined to the workspace providers. Public startup requires a bearer token.

## Railway

The Dockerfile packages the Node server, Python and basic shell utilities; it does not run a
Docker daemon or create per-agent containers. The service runs as the unprivileged `node` user.
`railway.toml` checks `/healthz`. Configure `OPENAI_API_KEY`, a random `EXPERT_MCP_TOKEN`, and
`PORT=8080` in Railway. The image binds `0.0.0.0` and selects the local backend. Railway's generated
public hostname is allowed automatically; use `EXPERT_MCP_PUBLIC_HOST` for a custom hostname.

Deploy this directory with `railway up` and generate a domain targeting port 8080. The MCP URL is
`https://<your-domain>/mcp`; clients must send `Authorization: Bearer <EXPERT_MCP_TOKEN>`.
Clients must support protocol revision `2026-07-28` (older revisions are rejected).
Health and discovery do not call OpenAI. Expert consultations use your configured key and incur
model charges. Workspaces, tasks and dispatches are ephemeral and are lost on redeployment;
run one replica so polling reaches the same in-memory task store.

## Development

```bash
npm run verify          # typecheck · eslint · vitest (unit + integration) · build
npm test                # tests only; vitest run --project unit|integration
```

Tests never reach OpenAI or Docker: the model is `ScriptedModel` from `@openai/agents/testing`, the
sandbox is an in-memory session, and `test/setup.ts` rejects any non-loopback socket. The
integration test runs a real HTTP listener on `127.0.0.1` and drives the full task lifecycle with
the 2026-07-28 headers and `_meta` envelope.

### Adding an expert

Add an entry to `EXPERTS` in `src/experts/registry.ts` (`id`, `title`, `description`,
`instructions`, `maxTurns`). The tool `expert_<id>` appears automatically; `list_experts` and the
tool catalogue test pick it up.

## Manual live check

1. `.env` with `OPENAI_API_KEY`; `npm run dev`.
2. Ask `expert_research` something trivial → `ANSWERED`.
3. Ask `expert_engineering` something that needs work (paste a log into `context`) →
   `EXPERT_AGENT_DISPATCHED`; `expert_status` shows commands running; `expert_collect` returns the
   report.
4. With the local backend, the temporary `expert-workspace-*` directory exists during the
   consultation and is removed when the session finishes or is cancelled.
