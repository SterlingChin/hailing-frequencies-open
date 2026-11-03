# Hailing Frequencies Open

Federation Customer Service for a fictional starship crew: a Star Trek-style help desk you can phone. A crew member calls a Twilio number, gives a fictional authorization phrase, and talks to an AI support officer about a broken replicator or a report that will not open. The officer remembers the caller's earlier cases, can text a summary, and hands harder problems to specialist agents. The crew, cases and repair procedures are invented; Michael Watson makes a cameo as an ensign in the demo roster.

Sterling Chin and Michael Watson built it for the CodeTV Web Dev Challenge in October 2026. The challenge's sponsors were OpenAI and Twilio.

## What is in it

- **Voice desk** (`voice/`, `app/server.mjs`). A signed Twilio webhook and media stream bridged to OpenAI's `gpt-live-1` voice model, which delegates tool calls to `gpt-6-luna`. Calls are capped per process (`VOICE_CALL_LIMIT`, default one) and in length (`VOICE_MAX_SESSION_SECONDS`, default 120).
- **Crew CRM** (`crm/`, `db/migrations/`). Postgres records for crew profiles, contact points, equipment, cases, interactions, specialist tasks, part orders and outbound messages, with an in-memory repository for tests. The phone number is only a lookup hint; the spoken phrase loads a demo profile, and a case is resumed only after the caller confirms it.
- **Specialist tools.** Engineering (`lookup_repair`) and Logistics (`check_parts`) answer from an authored fictional catalog; a parts check never places an order.
- **Routing decisions** (`decisions/`, `context/`, `queue/`). OpenAI's Decisions API (`POST /v1/decisions`) scores the caller's request against the CRM context. The outcome is to answer from a stored solution, ask for more detail, or prepare a handoff to the IT or Maintenance desk, which Michael's reporting service carries out through the Expert Agent MCP server.
- **SMS and return calls** (`sms/`, `reply/`). When the caller asks for it and confirms the number they are calling from, the officer texts the stored repair summary there. Sends are never retried automatically, and Twilio status callbacks are signature-checked. Reply texts and return calls for queued work exist behind flags; callbacks for the IT and Maintenance desks belong to the specialist services and are not wired here.
- **Companion screen** (`web/`, `design-system/`). An LCARS-inspired bridge console served by the same app. It plays authored fixture conversations over server-sent events and is not connected to live calls.
- **Partner APIs** (`app/caller-context-api.mjs`, `app/decisions-api.mjs`). Bearer-token APIs used by Michael's reporting service. See [docs/caller-context-api.md](docs/caller-context-api.md) and [docs/decisions-api.md](docs/decisions-api.md).
- **Michael's services**, each a separate package with its own README: the iPhone communicator in [reporting-ui/](reporting-ui/README.md) and the [Expert Agent MCP server](expert-agents-mcp/README.md), whose Research, Engineering and Logistics agents run on OpenAI.

## API context in `.sannr/stacks`

The API knowledge gathered during the build, for Twilio, OpenAI and the project's own services, sits beside the code with one folder per API:

| Stack | API | Environments | Credential variables |
| --- | --- | --- | --- |
| `openai` | OpenAI API (base URL includes `/v1`) | `production`, `reporting-test` | `OPENAI_API_KEY`, `REPORTING_OPENAI_API_KEY` |
| `twilio` | Twilio core API v2010 | `production` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| `messaging` | Twilio Messaging v1 | `default` | same as `twilio` |
| `lookups` | Twilio Lookup v2 | `default` | same as `twilio` |
| `verify` | Twilio Verify v2 | `default` | same as `twilio` |
| `app` | This app's own HTTP API | `production`, `reporting`, `reporting-test` | `CONTEXT_API_TOKEN`, `REPORTING_API_TOKEN`, `REPORTING_CONTEXT_API_TOKEN` |
| `reporting-ui` | The communicator's server routes | `production`, `custom-domain` | none stored (browser session) |
| `specialists` | The Expert Agent MCP server | `production`, `reporting-test` | `SPECIALISTS_MCP_TOKEN`, `REPORTING_EXPERT_TOKEN` |
| `unsorted` | Seven OpenAI entries with no contract binding | none | not runnable |

Each folder holds the API's contract (the provider's published OpenAPI spec, or one written for this project's own services), a `sannr.json` with the operations and dated notes, and a `stack.json` naming the environments and the environment variables that hold credentials. No credential values are stored. Every environment is marked production, including those named `default`. The `app`, `reporting-ui` and `specialists` environments point at the original challenge deployments, which may no longer be running.

Read the notes as history. Every note is dated and says what it rests on: documentation, a request made during the October 2026 build, local source and tests, or a known limitation of an early Sannr version. No operation is marked verified by execution, and none of it is a claim about how OpenAI or Twilio behave today. Human-readable guides (README, GOTCHAS and BUGS for each provider) are in [docs/api-prep/](docs/api-prep/README.md), and [docs/api-prep/IMPORT.md](docs/api-prep/IMPORT.md) records where everything came from.

### Read it without installing anything

The files are Markdown, JSON and YAML. Give a coding agent this prompt:

> Read docs/api-prep/README.md, the relevant GOTCHAS.md and BUGS.md, and the matching .sannr/stacks/<name>/sannr.json. Summarize the API lessons that apply to my task, separating dated reports from current verification. Do not install tools or call APIs.

### Use it with Sannr

[Sannr](https://sannr.dev) is an API client for coding agents: it reads what is already known about an API before a request and records what it learns beside the code. It needs Node 22 or newer on macOS or Linux. From the repository root:

```sh
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm run sannr:setup
```

`sannr:setup` runs `sannr connect`, which installs Sannr's agent skills, registers its MCP server for your coding agent and refreshes the Sannr block in `AGENTS.md`. It makes no API requests. Reopen your coding agent in this folder, accept its project trust or MCP prompt if one appears, and paste:

> Finish Sannr setup. Confirm that the loaded tool's setup binding matches this repository. Read AGENTS.md and docs/api-prep/README.md, then retrieve the relevant Twilio or OpenAI stack notes. Report missing configuration without making API requests.

There is no default stack. Name one with `--stack` on the command line or `stack` in the MCP tool, so a relative path cannot reach the wrong provider. These commands read saved context and send nothing:

```sh
npm run sannr:stacks
./node_modules/.bin/sannr show 'POST /responses' --stack openai
./node_modules/.bin/sannr show 'POST /v2/Services/{ServiceSid}/Verifications' --stack verify
```

To make real requests, copy `.env.example` to `.env` and add your own keys. Keep `.env` out of Git and out of chat.

## Run it locally

You need Node 22 or newer. Postgres 16 is needed only for the CRM, seeds and the database tests.

```sh
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm start            # app on http://127.0.0.1:8788 (start:voice is an alias)
npm test             # offline suites: voice, CRM, app, SMS, Decisions and queue
```

Without a database, `npm start` serves the companion screen and `/health`, which reports the database as `not_configured`; the CRM tools are unavailable. Nothing reads `.env` automatically. Export variables in your shell or run `node --env-file=.env app/server.mjs`.

For the CRM, start a disposable loopback Postgres in a second terminal, point `DATABASE_URL` at it in your shell (host `127.0.0.1`, port `55438`, database `hfo_crm_local`, user `postgres`), then migrate and seed:

```sh
docker run --rm --name hfo-crm-local -p 127.0.0.1:55438:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=hfo_crm_local postgres:16
npm run db:migrate
npm run db:seed -- --scenario returning   # or fresh, two_open; set DEMO_CALLER_E164 first
npm run db:seed:roster                    # nine fictional crew
```

The seed commands refuse non-loopback databases; the roster seed makes an exception only for a host named with `--remote-host`. Set `TEST_DATABASE_URL` to a disposable loopback database to add the Postgres tests in `crm/postgres.test.mjs` and `app/decisions-api.test.mjs` to `npm test`; without it they are skipped. `reporting-ui/` and `expert-agents-mcp/` have their own `npm test`.

Every feature flag defaults to off, so a fresh checkout makes no Twilio or OpenAI requests:

| Variable | Turns on | Also requires |
| --- | --- | --- |
| `VOICE_ENABLED=true` | Twilio voice webhook and media stream | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_PUBLIC_DOMAIN` (public HTTPS origin), `OPENAI_API_KEY` |
| `SMS_ENABLED=true` | Summary texts | the Twilio variables above, `TWILIO_SMS_FROM`, `DATABASE_URL` |
| `DECISIONS_ENABLED=true` | Decisions API routing | `OPENAI_API_KEY` |
| `CALLBACK_ENABLED=true` | Return calls | `VOICE_ENABLED=true`, `TWILIO_VOICE_FROM`, `DATABASE_URL` |
| `CONTEXT_API_TOKEN` | Caller-context API | at least 32 characters |
| `REPORTING_API_TOKEN` | Reporting and Decisions APIs | 32 to 256 characters |

`HOST` and `PORT` override the bind address. With `NODE_ENV=production` the app requires `DATABASE_URL`. [.env.example](.env.example) lists the app's variables.

## License

MIT; see [LICENSE](LICENSE). The OpenAI and Twilio specifications under `.sannr/stacks` keep their own licenses; see [NOTICE](NOTICE).

## Project history

The build's working journal (deployment handoffs, configuration changes, the October 12 whiteboard and routing decisions) is kept as a dated record in [docs/journal-2026-10.md](docs/journal-2026-10.md). [docs/going-public.md](docs/going-public.md) is the owner's checklist for publishing the repository.
