# Project journal, October 2026

This is the working journal Sterling Chin and Michael Watson kept in the repository README while building Hailing Frequencies Open for the CodeTV Web Dev Challenge in October 2026. It was moved here on November 2, 2026, when the README was rewritten for new readers, and is kept as the dated record of the build: deployment handoffs, production configuration changes, whiteboard pointers, the handoff list and the routing decisions. Each statement describes the repository and its Railway deployment as they stood on the date given; where entries disagree, later entries, the code and the other documents in this folder win. The old README's first fifty lines (the project description, the get-started steps and the stack table) were not moved; the rewritten README replaces them. The rest of the text is as it was in the README except for three edits made before the repository went public: the production hostname is replaced with `<your deployment URL>`, two Railway deployment IDs are removed, and relative links are re-based so they resolve from this folder.

## What was carried over

The initial import contains 671 bound operations and 148 authored notes, including 24 client limitations scoped to alpha.10. The [import record](api-prep/IMPORT.md) explains the sources, exclusions and checks. All imported notes remain historical or documentation-based claims, with zero provider executions verified in this workspace at import.

The original preparation repositories remain separate. This workspace has independent stack files, local credentials and future observations. Third-party contract licenses are retained with their source attribution; this import does not choose the application's future open-source license.

## Crew CRM and case memory

Michael's server-to-server caller lookup is documented in [the caller context API handoff](caller-context-api.md). It starts a short private session, requires the existing fictional authorization phrase before returning the CRM's safe profile, and is disabled until `CONTEXT_API_TOKEN` is configured. It does not establish real-world identity or call Twilio Verify.

The [build spec](crew-crm-spec-2026-10-11.md) is implemented in `crm/`, with plain SQL in `db/migrations/`. Crew profiles, contact points, preferences, equipment, cases, interactions, timeline events, specialist tasks, part orders and outbound message requests have separate records. The service runs on either `MemoryRepository` (offline demos/tests) or `PostgresRepository` (`pg` Pool). Application callers use `createCRMService`; the repository interface is internal and does not enforce caller authorization on its own.

The service hashes normalized fictional authorization phrases, permits three attempts per interaction, and returns phone candidates as IDs only. Profile loading exposes no phone numbers or authorization hashes to the model. Resuming a case requires an explicit caller-confirmation flag and ownership checks. Symptom revisions invalidate old findings; specialist results can finish after a call ends. A caller-confirmed fix sets `confirmed_fixed` while keeping the case **open**, as Sterling requested; only explicit closure sets `closed`. Closed cases cannot be silently resumed.

`crew_members.preferred_language` is constrained to `english` or `klingon` and defaults existing crew to English. It is returned with the safe profile and CRM context; the reporting and voice agents use it for spoken replies after profile loading. Michael Watson is the seeded Klingon example. The older free-text `language` field remains for existing data and is not the speaking preference.

Message requests require explicit consent and an idempotency key. This module records requests and status observations; it does not send SMS. Statuses advance through requested → queued → submitted → sent → delivered, or a terminal failed/undelivered state. The first terminal outcome stays current; later conflicting or out-of-order observations remain in the full history. The signed adapter in `sms/callback.mjs` supplies message IDs/provider SIDs. Part records distinguish available, reserved, ordered, shipped, delivered and cancelled; shipped requires a carrier and ETA. Case briefs use stored facts and are at most 600 characters.

Transactions serialize CRM work with one Postgres advisory lock to protect the small demo from concurrent callbacks/tool requests. Events and their state changes commit together. The memory implementation provides the same transaction interface and rollback behavior; relational constraints are enforced by Postgres. Migrations record filenames and checksums in `schema_migrations`, skip unchanged files on rerun, and reject edits to an applied migration. Add a new numbered migration for later changes.

### Local setup and scenarios

Use Node 22+ and Postgres 16. Install with `npm ci --ignore-scripts --omit=optional --no-audit --no-fund`. The copied voice bridge retains its `twilio` and `ws` dependencies; `pg` is the only added CRM runtime dependency. No runtime files or credentials are loaded from sibling repositories.

One disposable loopback-only database can be started with:

```sh
docker run --rm --name hfo-crm-local -p 127.0.0.1:55438:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=hfo_crm_local postgres:16
```

Set `DATABASE_URL` privately in the process environment to that local database (host `127.0.0.1`, port `55438`, database `hfo_crm_local`, user `postgres`). Do not print or commit it. Set `DEMO_CALLER_E164` to the fictional demo contact you choose. No phone number is embedded in the seed module, and seeding makes no provider requests. Application and CLI code read only process environment variables. To load a private local file explicitly, use Node 22’s `--env-file=.env` flag (for example `node --env-file=.env scripts/db-migrate.mjs`).

```sh
npm run db:migrate
npm run db:seed -- --scenario fresh
npm run db:seed -- --scenario returning
npm run db:seed -- --scenario two_open
npm run test:crm
npm run test:voice
```

Each seed command replaces only the fixed fictional demo profile's rows in a transaction; unrelated crew and cases are preserved. `fresh` has no cases and opens `HF-042` on a new demo database. `returning` includes `HF-038`, opened last week, a `not_fixed` repair outcome, a regulator shipped by Subspace courier with tomorrow's ETA, and a fictional delivered SMS. `two_open` adds `HF-041` for a mess-hall food synthesizer. Dates are relative to seed time. All scenarios use Commander Avery Chen of USS Wayfinder, RPL-2400 on Deck 7, and the fictional phrase “Authorization, Chen, Avery, Alpha seven, Bravo nine, Echo two” (`CHEN-AVERY-A7B9E2`). Seeded delivery/shipment records are invented demonstration history, not provider observations.

`crew_members.auth_code_hash` stores the normalized phrase's SHA-256 hash; no plaintext phrase column is needed. The separate Railway roster seed does not include Avery. To add Avery's returning-caller demo without replacing other crew or existing Avery history, use `scripts/seed-avery-railway.mjs` with Railway's Postgres `DATABASE_PUBLIC_URL`, the exact public database hostname, and a fictional E.164 caller number. This operator command refuses the wrong Railway project/environment, adds Avery only if absent, and otherwise rotates only the expected old demo hash. The caller-context API can load Avery by phrase even when the incoming phone does not match the fictional contact number.

`test:crm` skips Postgres integration tests unless `TEST_DATABASE_URL` is set in the test process environment. Set it privately to a disposable local Postgres database, then run the same command. Integration tests create and remove isolated random schemas and require permission to create schemas. Test and seed commands accept only loopback database URLs without connection-query overrides. Tests never read production database configuration from `.env`. Unit and voice tests require no provider credentials. Stop the disposable database with `docker stop hfo-crm-local` when finished.

### Voice and the existing Railway setup

`voice/config.mjs`, `voice/bridge.mjs`, `voice/server.mjs` and their two test files were copied from the preparation project and adapted here. The browser playground, live smoke runner and preparation credentials were not imported. The signed incoming webhook binds `From` and `CallSid` to a one-use ticket; only the private call context receives the phone hint. Delegated CRM tools load the profile, resume/open a case, update its symptom, retrieve a brief, record a caller's repair outcome, or close the case. `lookup_repair` supports both RPL-7 and RPL-2400 and stores a task against a snapshot of the selected case's revision. Database failures return an honest unavailable-memory response while the authored fictional repair catalog remains usable. The partner caller-context API is the only exposed CRM JSON path; it requires a server token and fictional phrase before returning a safe profile.

The app now starts with `npm start` (Node 22) at `127.0.0.1:8788` locally. With Railway’s `PORT` it binds `0.0.0.0:$PORT`; `HOST` can override the host. `npm run start:voice` is an alias for the same app. Nothing reads `.env` automatically. For an explicit local env file, use `node --env-file=.env app/server.mjs`.

The default startup enables neither voice nor SMS. `/health` checks the configured database’s migration table and returns 503 if it cannot be read, without making provider requests. Without a database it reports `not_configured`; production requires `DATABASE_URL`. This is app/database readiness, not a provider integration check.

### Railway deployment handoff

Sterling approved pushing `main` and deploying the staged app and Postgres on October 11, 2026, with `VOICE_ENABLED=false` and `SMS_ENABLED=false`. That approval does not authorize calls or texts. The committed `Dockerfile` uses Node 22, installs only locked runtime dependencies with scripts disabled, and excludes local secrets and Sannr evidence. Railway detects the Dockerfile. The app service explicitly runs `npm run db:migrate` as its pre-deploy command, starts `npm start`, and checks `/health` with a 60-second timeout. Its restart policy is `ON_FAILURE`, with three retries. Migration failure blocks the deployment. Seeds never run on deploy.

Deployment settings:

1. Keep `hailing-frequencies-app` on `main` and its existing Postgres service. The app root is this repository. Review commits before any push that could trigger an automatic deploy.
2. Set `DATABASE_URL` by reference to `Postgres.DATABASE_URL`, its private connection variable. Do not copy the URL into logs or source. The image sets `NODE_ENV=production` and `HOST=0.0.0.0`; Railway supplies `PORT`. Confirm the service settings match the migration, start, healthcheck and restart values above. Keep `VOICE_ENABLED=false` and `SMS_ENABLED=false` until a separate live rehearsal is authorized.
3. Set `VOICE_ENABLED=true` only for the authorized voice rehearsal, with `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VOICE_PUBLIC_DOMAIN` (the app’s canonical HTTPS origin, no path). These remain private environment values.
4. The bridge admits one simultaneous call. `VOICE_CALL_LIMIT` defaults to **one total call per process**, preserving the rehearsal budget; set it deliberately (for example 5) for repeat/returning calls. `VOICE_MAX_SESSION_SECONDS` defaults to 120 and is capped at 600. Use one app replica because media tickets and call admission are process-local. Restarting resets the call budget.
5. Confirm migration success and app health after the approved deployment. Authorize and rehearse the real signed Twilio webhook/media stream separately. Offline tests do not establish audible conversation, real consent recognition, delivery, or Railway persistence.

Railway's legacy `railway.json`/`railway.toml` configuration is deprecated and unavailable to new services. This repository's ineffective `railway.json` was removed after deployment exposed that limitation. The current app uses explicit Railway service settings; future configuration automation should use [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), with a reviewed plan for the existing resources. See also [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

The companion’s Railway address is `<your deployment URL>`. On the first October 11 rollout, Railway reported a successful container start but `/health` returned 503 with database unavailable; both feature flags were false. Deployment context showed no healthcheck or custom start command, and logs contained no migration run. The service's migration, start and healthcheck settings were then explicitly applied. Always verify the migration log and `/health` response, not just Railway’s deployment status.

The `app` Sannr stack binds only this application’s unauthenticated health endpoint. For a deployment check, select `stack: "app"` and `environment: "production"`, request `GET /health`, and assert HTTP 200, `status` and `database` equal `ready`, `companion` equal `fixture`, and both `voiceEnabled` and `smsEnabled` equal `false`. This check makes no OpenAI or Twilio requests. Private request evidence remains ignored by Git.

Deployment verification on October 11 at 22:02 UTC: an app deployment from `main` commit `0e52a9d` reached `SUCCESS`. Its logs recorded one applied migration, startup on `0.0.0.0:8080`, and a passing Railway healthcheck. The public Sannr health check passed all six assertions above. Postgres was also `SUCCESS`. Browser inspection confirmed the hosted fixture feed, opening exchange and captions, with no browser warnings/errors. No calls, texts, live model sessions or demo-data import were performed; the screen still uses fictional fixtures.

Reporter-supplied conversation text is stored in CRM by the Decisions intake described below. No audio capture, automatic transcription, SMS reply routing or retention/deletion job is included. Retention duration and SMS reply policy remain future decisions.

### Requested SMS and specialists

The voice tools now include Engineering (`lookup_repair`), Logistics (`check_parts`), and `request_repair_sms`. Both specialists record their task against the current case/revision; obsolete results remain in the timeline and cannot replace the current diagnosis. Logistics uses an authored fictional catalog for RPL-2400 and RPL-7. A check reports availability only and creates no order.

The SMS tool requires both a caller request and confirmation that the number they are calling from is the destination. The signed call’s number must match a contact on the loaded profile. Neither a saved preference nor an arbitrary model-supplied number/body can initiate a send. The summary is built from the selected case’s stored diagnosis and steps. `SMS_ENABLED=false` is the default. To enable an authorized rehearsal, set `SMS_ENABLED=true` and `TWILIO_SMS_FROM` to an assigned SMS-capable E.164 number, with the credentials, canonical origin and database configured above.

A durable `queued` claim prevents concurrent or repeated tool invocations from sending the same summary twice within the interaction. Definite provider rejection records `failed`; timeout/connection/5xx outcomes stay unconfirmed and **never retry automatically**. A crash between claiming and sending can leave an unsent request queued. Reconcile that uncertainty by hand before requesting another send. This is duplicate prevention, not a guaranteed delivery queue.

The app gives each send a canonical `https://<app-domain>/sms/status/<message-id>` callback URL. The endpoint validates Twilio’s signature against that exact origin and all form fields, checks the account and message SID, and calls `recordMessageStatus`. It remains available for callbacks when sending is disabled. Duplicate, late and contradictory statuses stay in history; they cannot move a terminal status backward. Only a recorded delivery callback can yield a delivered claim from this path. Do not configure the callback by copying an individual message UUID into Railway.

Offline tests inject a sender and fake signed callbacks: no texts or provider requests are made. Real caller intent recognition, signature behavior through Railway, carrier acceptance and delivery remain unverified. See [Twilio status callbacks](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status) and [webhook signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

### Crew roster (October 12)

Migration `003_crew_roster.sql` adds department, section, clearance level, posting, service number and status to a crew member. The safe profile also derives `contact_count` and `last_contact` from finished interactions, so "when they talked to us" is never stored twice. `npm run db:seed:roster` loads nine fictional crew with spoken-phrase authorization codes, contact points, preferences, equipment and, for four of them, a prior contact with a case. The roster, its schema and the phrase rules are in [docs/crew-roster-2026-10-12.md](crew-roster-2026-10-12.md). Like the scenario seed it refuses non-loopback databases.

### Reporting agent owns routing and MCP execution (October 12)

Production configuration update, October 12 at 21:50 UTC: Sterling authorized production enablement after a caller response returned `decisions_unavailable`. A Railway deployment of main `83f8721` succeeded with `NODE_ENV=production`, `DECISIONS_ENABLED=true`, `VOICE_ENABLED=true`, and the app's Railway origin as `TWILIO_VOICE_PUBLIC_DOMAIN`. A repository-bound Sannr `GET /health` then passed seven assertions: HTTP 200, app/database ready, Decisions/voice enabled, SMS/callbacks disabled (private evidence `run-bb9cee3b-e51c-4aa9-9c1e-491b9e8c1acc`). Sterling deferred SMS/callback setup when the required sender numbers were missing. This supersedes the earlier all-flags-off operating instruction; it verifies process configuration, not a live model answer, call, or SMS delivery. The local follow-up-scoring revision was not part of that deployment.

The reporting and routing agent are now one agent. Michael sends `{crew_member_id, context}` after authenticating the caller. Our Decisions backend stores the full reporter blob in CRM, loads the caller’s full history and shared context, and returns one of three actions: respond with a stored answer, gather more context and ask Decisions again, or hand off to IT/Maintenance. It returns the proposed MCP tool and a serialized `context` argument; it never invokes MCP or automatically starts the queue worker. Both desks currently use the declared `expert_engineering` tool. The reporting backend owns dispatch claims, execution and collection. See [the current handoff contract](decisions-api.md) for response fields and Michael's integration steps. Migration `006_reporter_context.sql` adds private blob storage; existing session-based requests remain compatible. Both app entry points mount `/api/decisions`; production enablement is recorded above.

### Earlier decision step, queue routes and replies (October 11)

The historical workflow below is superseded where it describes automatic specialist dispatch or callbacks through the reporting agent. The current boundary is documented above.

The notebook sketch routes every request through OpenAI's Decisions API (`POST /v1/decisions`, model `gpt-6-luna`) before anything is queued. `context/bundle.mjs` builds one text block from the safe profile, the selected case brief and the caller's words, withholding phone numbers. `decisions/` holds the fixed question set with explicit thresholds, a no-retry client that validates the answer list and never logs bodies, and the step that turns a queue outcome into a specialist task. The voice tools gained `route_request` and `request_reply`: the second records the caller's consent to a call or text at the number they are calling from, and nothing else can set a reply destination.

Migration `002_routes_and_replies.sql` adds the `access`, `maintenance` and `expert` routes beside `engineering` and `logistics`, plus reply consent, claim and outcome columns on the task. `queue/worker.mjs` runs an injected specialist handler per route (`options.specialists` in `createApplication`; retained for explicit worker use and fake rehearsals), records a bounded result, and delivers the reply. `reply/sms.mjs` reuses the SMS claim and no-retry send. `reply/call.mjs` places a return call through a ten-minute single-use ticket; `POST /outbound-call?ticket=…` is signature-checked against the exact URL and bound to the callee, and the officer asks for the authorization phrase before saying anything about the case. A return call reveals its result only to the profile that queued it.

`DECISIONS_ENABLED` and `CALLBACK_ENABLED` default to false. The first requires `OPENAI_API_KEY`; the second requires `VOICE_ENABLED=true`, `TWILIO_VOICE_FROM` and `DATABASE_URL`. One authorized Decisions probe on October 12 returned HTTP 200 with 17 passing assertions and selected Access with routine urgency for Tavi Rourke's returning-case fixture; one fixture does not calibrate the thresholds. The worker is in-process; new Decisions requests now prepare a reporting-owned handoff instead of triggering it; after a restart, `queue.sweep()` delivers any replies still due. Sterling's [whiteboard page](whiteboard-2026-10-12.md) records the probe, evidence reference and wording recommendations. All four Railway feature flags remain false according to the prior handoff; this probe changed no Railway settings and did not recheck production health.

### Companion screen and fixture stream

Open `http://127.0.0.1:8788` after `npm start`. The same server serves the companion, `/health`, the voice webhook/media socket, and the signed SMS status endpoint. There is no separate frontend service or Sites dependency. The page imports `design-system/tokens.css` and `components.css`, uses bridge-console zones and large captions, and presents the recap on a light communications-desk timeline. At narrow widths the conversation and next step come first.

The opening exchange is “Open a channel to Federation Customer Service.” → “Channel open.” The fixture shows that exchange before the support conversation; the voice greeting begins with the same acknowledgement before requesting the fictional authorization phrase. An always-listening “Computer” wake word is a future idea: the companion currently requests no microphone access and performs no speech recognition or voice-command dialing.

`GET /events?scenario=repair` streams complete SSE snapshots with `source: "fixture"`, connection, speaker, caption, crew/case context, specialist tasks, requested message state and an ordered recap. Other authored scenarios are `returning`, `failure`, and `revised`. Pause/resume, replay, and scenario controls affect only the current browser preview; they never start calls or request texts. `Last-Event-ID` resumes at the next scenario-scoped snapshot. The stream sends heartbeats, bounds clients and closes slow consumers. The final `complete` event stops reconnecting; the recap stays visible.

The on-screen summary is selectable and has a copy button. It remains available in the fixture stories when SMS is unavailable or fails. The **live voice/CRM events are not connected to this feed yet**: it never exposes actual caller records, numbers, authorization phrases, provider payloads or transcripts. The live SMS tool returns the stored summary even when sending is unavailable, so the officer can read it aloud. Before presenting real case summaries on screen, add an authorized per-case subscription and wire connection/speaker/caption/task/case/message events to it. Do not broadcast a global current call or open public CRM JSON routes. Never claim a live caller’s summary is visible in this fixture screen.

### Tomorrow’s handoff — Sterling and Michael

Agree who owns each item before rehearsing. Suggested split (not an assignment): **Sterling** owns Railway approval, environment review and CRM scenario preparation; **Michael** owns Twilio number/Dev Phone setup and the call script. Split live companion-event wiring and SMS readiness explicitly; rehearse together.

The October 12 handoff reported that migrations 001–003 and the eight-person fictional roster were already loaded on Railway, while Avery Chen's returning-caller scenario remained local-only. It also left these follow-ups for Sterling after remote seeding: disable Postgres public networking, rotate the exposed Postgres password and update the corresponding service variables before redeploying the app, and remove the connection-URL entry from local shell history. These are carried-forward tasks, not checks or changes performed by the Decisions probe.

- Buy or assign the required Twilio number(s), pair the desktop Dev Phone, and confirm the support number routes `POST /incoming-call` to the approved app domain. Dev Phone can replace a number’s webhooks: use a spare caller-side Dev Phone number and keep the support number’s webhook intact. Do not point Dev Phone at the support number without checking the final route. See the repository’s dated Dev Phone notes and [Twilio Dev Phone documentation](https://www.twilio.com/docs/labs/dev-phone).
- Choose an SMS route: complete the applicable A2P 10DLC registration and verify readiness before enabling US 10DLC sending, or keep `SMS_ENABLED=false` and use the on-screen fallback. The current fallback screen is a fixture until the live subscription is wired. No registration or number purchase was performed here.
- The first Railway deployment is approved with voice and SMS disabled. Review the environment and explicitly authorize the live rehearsal before enabling either feature; the app’s environment table is in `.env.example` and the deployment steps are above.
- Choose the live demo profile/seed procedure. `npm run db:seed` intentionally refuses remote databases; production migration creates the schema but loads **no demo profile**. Do not remove that guard to seed Railway casually. A separately authorized, scoped import of the fictional profile/scenario is still required before a real returning-caller rehearsal.
- Rehearse spoken authorization, case confirmation, cold coffee, Engineering, Logistics, “Text me the details” with destination confirmation, fallback/delivery wording, and a second call. Set an intentional `VOICE_CALL_LIMIT` greater than one for the returning-caller beat.

Run `npm test` for all offline suites: voice, CRM/specialists, app/SSE, SMS, Decisions and queue. With a loopback `TEST_DATABASE_URL`, the same command also runs the Postgres contracts and migration/seed CLI checks. No production credentials or provider traffic are required.

Run `node --test app/sciences.test.mjs` for the Sciences rehearsal alone: Tavi's roster profile → confirmed HF-031 → fake Decisions answer → Access worker → explicit reply consent → fake SMS → signed fake delivery callback and saved case events. It covers both a specialist finishing before consent and one finishing afterward, with no duplicate send. The companion remains a separate fixture preview. See [the October 12 whiteboard](whiteboard-2026-10-12.md#sciences-rehearsal-with-fakes-october-12) for the result and limits. The full October 12 offline run passed **114 tests with zero failures or skips**, including disposable Postgres 16; revised question wording has not been tested against a live model.

### Scaffolding verification recorded October 11, 2026, before deployment approval

- **92 tests passed, zero failures/skips**, using `npm test` under Node 22 in the built Docker image, with fake model/Twilio transports and a disposable loopback Postgres 16 database: 36 voice, 44 CRM (memory and Postgres), 7 app/SSE, 5 SMS.
- The runtime image built successfully. Its migration command applied the schema once and applied zero migrations on rerun. The packaged app started on `0.0.0.0` with the supplied `PORT` and closed cleanly. All three seed CLI scenarios were tested in isolated local schemas.
- Browser inspection at 1440×900 and 390×844 confirmed the desktop zones, mobile reflow without horizontal overflow, visible repair fallback and working copy action. The preview produced no browser warnings/errors during inspection.
- **Not verified:** Railway’s actual staged configuration or deployment, provider credentials/account access, a real Live conversation or spoken-consent interpretation, a real Twilio signature through Railway ingress, carrier SMS acceptance/delivery, and production database persistence. Live companion event projection and the controlled Railway demo-data import are still future work.
- This task made no calls, texts, live model sessions, Twilio writes, Railway changes, deployments or pushes. The initial CRM and voice work was committed separately before scaffolding changes. Test output, setup evidence and local feedback remain ignored by Git.
