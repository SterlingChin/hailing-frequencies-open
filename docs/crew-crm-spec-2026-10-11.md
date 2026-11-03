# Crew CRM and case memory: build spec

Written October 11, 2026, for the coding agent picking this up. Sterling and Michael are the decision makers; this spec records what they asked for and the defaults chosen where they did not say.

Implementation decisions confirmed by Sterling on October 11, 2026: copy the needed voice source and tests into `hailing-frequencies-open` rather than depend on the sibling preparation repository; keep a case **open** after a confirmed fix until the caller explicitly closes it. This supersedes the resolved/reopen default below. Railway was set up separately and is outside this implementation's verification.

## Goal

When a crew member calls back, the support agent should recognise them, find their earlier case, and say something like: "We talked about your replicator last week. The thermal regulator shipped by subspace courier and should arrive tomorrow." Every fact in that sentence must come from a stored record, not from the model.

To get there, build our own small CRM inside the app's Postgres database on Railway. No third-party CRM. It stores crew profiles, contact points, equipment, cases, specialist work, part orders and messages, and it gives the voice agent a few narrow lookup tools.

## Where it fits

The voice app is the Node 22 ESM project in this repository (`voice/*.mjs`, tests with `node:test`, run via `npm run test:voice`). Read these before changing anything:

- `AGENTS.md` for the repository's boundaries, which still apply in full.
- `voice/config.mjs` for `sessionConfig()`, `REPAIR_TOOL` and `lookupRepair()`. Delegated tools are declared under `delegation.responses.tools`.
- `voice/bridge.mjs` for `handleTool()`, which runs tool work off the socket callback, and for how `session.instructions.append` injects context once the session starts.
- `voice/server.mjs` for the signed `/incoming-call` webhook. It receives Twilio's `From` and `CallSid` and hands the call to the bridge through a one-time ticket.
- `../design/HAILING-FREQUENCIES-OPEN-DESIGN-BRIEF.md` for the product and the sample data.

Put the CRM in a new `crm/` folder and keep the voice changes small and well tested.

## Rules the data model must enforce

1. **A phone number is a lookup hint, not identity.** `From` may narrow the search to candidate profiles. Nothing about a profile or its cases reaches the model until the spoken authorization phrase loads the profile. Call that state "demo profile loaded", never "verified".
2. **Separate records persist on their own.** Profile, case, specialist task, part order and outbound message are separate rows, and none of them depends on a call still being live.
3. **Case IDs span calls.** A case (`HF-042`) can have many calls and texts. A new call either resumes an open case after the caller confirms it, or opens a new one.
4. **Confirm, don't assume.** If the profile has one open case, the agent asks whether this call is about it. If it has several, it asks which one. A case is attached to a call only after the caller confirms.
5. **Symptom revisions.** Changing the symptom increments `symptom_revision`. Specialist tasks record the revision they were started under. A result for an older revision is stored as `obsolete` and never becomes the case's current diagnosis.
6. **A diagnosis is proposed until confirmed.** Keep separate states: `proposed`, `confirmed_fixed` and `not_fixed`. Only the caller can confirm a fix.
7. **Message status only moves forward.** Requested → queued → submitted/sent → delivered, or failed/undelivered. Twilio callbacks can arrive out of order, so a late `sent` must not overwrite `delivered`. Keep the full status history. A preference for SMS never sends anything on its own; only an explicit request creates a message row.
8. **Part orders say what actually happened.** `available` (found, nothing reserved), `reserved`, `ordered`, `shipped` (with carrier and ETA), `delivered`, `cancelled`. The agent must not say "on its way" unless the status is `shipped`.

## Schema (first migration)

Use plain SQL migrations in `db/migrations/NNN_name.sql`, applied in order by a small runner (`scripts/db-migrate.mjs`) that records applied files in a `schema_migrations` table. The suggested tables are below. Adjust names if you have a good reason, but keep the rules above.

| Table | Purpose and key columns |
| --- | --- |
| `crew_members` | `id` (uuid), `display_name`, `rank`, `ship`, `auth_code_hash` (sha256 of the normalised authorization code, e.g. `CHEN-AVERY-A484B7`), `language`, `created_at` |
| `contact_points` | `id`, `crew_member_id`, `kind` (`phone`), `value` (E.164), `label` ("Avery's mobile"), `created_at`. Unique on (`kind`, `value`, `crew_member_id`); the same number may belong to more than one profile. |
| `channel_preferences` | `crew_member_id`, `topic` (`troubleshooting`, `repair_steps`, `parts_updates`), `channel` (`voice`, `sms`, `screen`), `updated_at` |
| `equipment` | `id`, `crew_member_id`, `model`, `location`, `last_service_at`, `last_service_note` |
| `cases` | `id` (text, `HF-` + zero-padded sequence), `crew_member_id`, `equipment_id`, `status` (`open`, `resolved`, `closed`), `title`, `symptom`, `symptom_revision`, `diagnosis`, `diagnosis_status` (`none`, `proposed`, `confirmed_fixed`, `not_fixed`), `next_step`, `opened_at`, `updated_at`, `resolved_at` |
| `interactions` | `id`, `case_id` (nullable until confirmed), `crew_member_id` (nullable until loaded), `channel` (`voice`, `sms`), `direction`, `provider_sid` (CallSid / MessageSid, unique), `started_at`, `ended_at` |
| `case_events` | `id`, `case_id`, `interaction_id`, `at`, `kind` (`profile_loaded`, `case_resumed`, `case_opened`, `symptom_updated`, `task_started`, `task_result`, `part_updated`, `message_requested`, `message_status`, `call_ended`, `note`), `summary` (one short factual sentence) and `data` (jsonb). This is the case timeline. |
| `specialist_tasks` | `id`, `case_id`, `specialist` (`engineering`, `logistics`), `assignment`, `symptom_revision`, `status` (`working`, `result_ready`, `failed`, `obsolete`), `result` (jsonb), `created_at`, `completed_at` |
| `part_orders` | `id`, `case_id`, `part_name`, `part_number`, `status` (above), `carrier`, `eta`, `updated_at` |
| `outbound_messages` | `id`, `case_id`, `contact_point_id`, `channel` (`sms`), `body`, `status`, `status_history` (jsonb array of `{status, at, error_code}`), `provider_sid`, `idempotency_key` (unique), `requested_at`, `requested_in_interaction_id` |

Do not store full call transcripts or audio. Events carry short summaries. Never put credentials in the database.

## Module layout

```
crm/
  repo-postgres.mjs   # SQL implementation, uses DATABASE_URL via pg Pool
  repo-memory.mjs     # in-memory implementation with the same interface (tests, offline demo)
  service.mjs         # business rules above; depends only on the repo interface
  tools.mjs           # model tool definitions + handlers bound to one call's context
  brief.mjs           # builds the short case brief the agent sees
  seed.mjs            # fictional seed scenarios
  *.test.mjs
db/migrations/001_init.sql
scripts/db-migrate.mjs
```

Service functions, roughly:

- `findCandidatesByPhone(e164)` returns candidate crew IDs only.
- `loadProfileByAuthCode({ spokenCode, candidateIds })` returns the profile, or a not-found result. Normalise the spoken phrase ("Authorization, Chen, Avery, Alpha four eight four Beta seven") before hashing. Limit attempts per call (3 is fine).
- `listOpenCases(crewId)` returns `[{ caseId, title, status, lastActivityAt, brief }]`.
- `getCaseBrief(caseId)` returns 600 characters or less: symptom, diagnosis and its status, next step, pending tasks, part order status with carrier and ETA, last message status, and when the case was last touched, as a relative phrase like "last week". Build it from records only.
- `openCase`, `attachInteraction`, `updateSymptom`, `startTask`, `recordTaskResult` (rejects or marks obsolete when the revision is stale), `recordPartUpdate`, `requestMessage` (idempotent), `recordMessageStatus` (forward-only, keeps history), `endInteraction`.

## Voice integration

1. `/incoming-call` already validates the signature. Carry `From` and `CallSid` alongside the existing ticket so the bridge gets a **call context**: `{ callSid, fromE164, candidateIds, crewId: null, caseId: null }`. Do not log the phone number.
2. Add delegated tools next to `lookup_repair`. Every handler is bound to that one call's context. The model never passes a crew ID or phone number, so it cannot read anyone else's records.
   - `load_crew_profile({ spoken_code })`: on success, sets `crewId`, records `profile_loaded`, and returns name, ship, equipment, preferences, and open cases with their briefs.
   - `resume_case({ case_id })`: only for a case of the loaded profile, and only after the caller confirmed. Sets `caseId`.
   - `open_case({ equipment_id, symptom })`
   - `update_symptom({ symptom })`
   - `get_case_brief()`: for the current case.
3. Update the session and delegation instructions to match the rules: use only what the tools return, confirm which case before resuming, ask when several match, never claim a delivery, shipment or fix the records don't show.
4. `lookup_repair` should record a specialist task against the current case and revision when one is selected. The existing catalog uses model `RPL-7`, while the design brief and seeds use `RPL-2400`. Make the catalog accept the seeded model and update the affected tests. Don't silently drop RPL-7 coverage.
5. If the database is unreachable, the call still works without memory. The agent says it can't reach case records right now and does not invent history. Test this path.
6. When the call ends, record `call_ended` and leave the case open with its pending work.

Read-only JSON endpoints for the future companion UI (`GET /api/cases/:id`, `GET /api/crew/:id/cases`) are optional in this pass. If you add them, they are for the local demo only and must not be exposed without a decision from Sterling.

## Seed data (all fictional)

`npm run db:seed -- --scenario <name>` resets the demo rows and loads one scenario. Compute dates relative to seed time so "last week" stays true.

- **Shared profile:** Commander Avery Chen, USS Wayfinder, contact "Avery's mobile" (a placeholder number from the seed env var `DEMO_CALLER_E164`, never hard-coded). Authorization code `CHEN-AVERY-A484B7`. Language English; troubleshooting by voice; repair steps by SMS. Equipment: Replicator RPL-2400, Deck 7, thermal calibration completed two weeks before seed time.
- **`fresh`:** no open cases. The call opens `HF-042` for "coffee arrives cold".
- **`returning`:** `HF-038` opened 7 days before seed time. Coffee and tea arrived cold. Engineering proposed calibration drift, the recalibration did not fix it (`not_fixed`), Logistics found a compatible thermal regulator, and the part order is `shipped` via "Subspace courier" with an ETA of tomorrow. One repair-summary SMS was `delivered`. The expected opening after the authorization phrase: the agent asks whether this is about the replicator case from last week and, once the caller confirms, gives the shipment status.
- **`two_open`:** `returning` plus a second open case on another device (e.g., a food synthesizer in the mess hall), so the agent has to ask which case.

## Railway and local setup

- Production target: a Railway Postgres service, with `DATABASE_URL` provided by Railway to the app service. **Do not** create, link or modify Railway resources, deploy, or push. Sterling does those. Document the exact steps in the README section you add.
- Local development: any Postgres 16 reachable through `DATABASE_URL` in `.env` (a Docker one-liner in the docs is fine). Never print the URL.
- `pg` is the only new runtime dependency. Install with `--ignore-scripts`, matching how this repo installs packages.
- npm scripts: `db:migrate`, `db:seed`, `test:crm`. Unit tests run against `repo-memory`. Postgres integration tests run only when `TEST_DATABASE_URL` is set and skip cleanly otherwise. `npm run test:voice` must keep passing.

## Boundaries for this task

Follow `AGENTS.md`. In particular, this task authorizes **no** calls, SMS sends, live model sessions, Twilio API writes, paid lookups, Railway changes, deployments or pushes. Everything is verified offline with tests and local Postgres. Keep `.env`, `.sannr/evidence/` and `.setup-logs/` private.

## Done when

- Migrations apply cleanly to an empty database and are idempotent on rerun.
- Each seed scenario loads, and `getCaseBrief('HF-038')` for `returning` mentions last week, the `not_fixed` outcome, and the shipped regulator with carrier and ETA, all from records.
- Tests cover: phone-only lookup reveals nothing before the auth code; wrong code and the attempt limit; one open case asks to confirm; two open cases asks which; a stale-revision task result is marked obsolete and doesn't change the diagnosis; message status can't move backward and keeps history; duplicate message requests are idempotent; a tool can't reach another profile's case; the database-down path.
- The bridge passes the call context and the new tools without breaking existing voice tests.
- A short README section explains the schema, scripts, seed scenarios and Railway setup steps for Sterling.
- Report what you verified by running tests, separately from what remains unverified (anything needing a real call, Railway, or Twilio callbacks).

## Open decisions (ask, don't guess)

- Whether a confirmed fix closes the case automatically or the caller explicitly closes it. Default for now: mark it `resolved`; it reopens if the caller calls back about the same equipment.
- How long call summaries and message history are kept. No deletion job in this pass.
- Whether SMS replies (stretch) attach to a case by most-recent-open, or always ask. Default: ask when more than one case is open.
