# Hailing Frequencies · iPhone communicator

A small Vite app sized for iPhone 12 (390 × 844 CSS pixels). Tap **Engage**,
confirm the fictional crew phrase, describe an issue, and review or download
its recap. The greeting is “Hailing frequencies open. Please state your name
and authorization phrase.” No external reporting service is connected.

## Fake-data flow rehearsal

The separate `/rehearsal.html` page rehearses reporting-agent intake → demo
identity confirmation → CRM context → an existing solution or IT/Maintenance
handoff. Every record, decision, finding and call is an invented fixture.
Specialists own the simulated callbacks. Queued, working, callback requested,
call placed and caller-confirmed completion remain distinct.

From `reporting-ui/`, after installing the locked dependencies:

```sh
npm run dev:rehearsal
```

Open `http://127.0.0.1:5174/rehearsal.html`. This command runs Vite alone,
does not load `.env` files, and never starts the app API or Live client.
Use the displayed `DEMO-484` code for simulated identity confirmation.
The existing Live communicator and its server contracts are unchanged.

For a built preview, run `npm run build:rehearsal`, then
`npm run preview:rehearsal` and open
`http://127.0.0.1:4174/rehearsal.html`. The separate `dist-rehearsal/`
output is ignored by Git and is not part of the existing deployment build.
See [the rehearsal notes](docs/rehearsal.md) for the story controls,
tests, state meanings and integration limits.

## Run the Live communicator

Requires Node 22.12+ and npm. From `reporting-ui/`:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The Node process serves both Vite and the
same-origin API; running plain `vite` alone does not provide the API.
The app uses the parent `design-system/tokens.css` and `components.css`.
Build from this checkout so those files are available.

```sh
npm test
npm run build
npm start
```

`npm start` serves the compiled `dist/` app and the same API, without Vite.
The built directory must be accompanied by the Node server and `ws` package.

## Voice conversation

Engage in the original communicator connects directly to GPT-Live. That page
has no scripted demo mode or mode switch; the rehearsal above is a separate
entry point. Microphone access requires HTTPS on an iPhone. The deployed Railway
URL provides HTTPS; allow microphone access in Safari, then tap Engage.
If Safari blocks agent audio, tap Play agent audio. Mute disables the local
microphone tracks; End releases them and closes the session.

Caller profiles and authorization are supplied by the companion caller-context
service. Set `CONTEXT_API_TOKEN` on this server and optionally override
`CONTEXT_API_BASE_URL`. Once the voice channel is ready and the opening greeting
is submitted, the server calls `/api/v1/caller-context/start` with `{}` (no phone
hint). The agent collects the caller’s actual name and authorization phrase and
submits `{session_token, name, authorization}` to `/authorize`. Only a
successful service response loads the profile; no local Avery fallback is used.
The agent welcomes the returned profile’s `display_name` and rank. Authorization
codes and attempt rules belong to that service. The server calls `/end` when the
voice channel ends, including cleanup for a lookup that finishes after cancellation.
Context sessions expire after 15 minutes under the current service contract;
restart the channel and authorize again after expiry. This does not impose an
application conversation-duration cap. Service/session tokens remain server-side.

Reports remain editable/selectable and
can be downloaded as JSON; they are never sent externally. They stay in server
memory until an hour of inactivity after a channel ends or a server restart.
The most recent 100 reports are retained without blocking new conversations.

For local voice testing, create a private `.env` from `.env.example`, set
`OPENAI_API_KEY` and `LIVE_ENABLED=true`, and restart. Use trusted HTTPS on the
phone via a private HTTPS proxy or `TLS_KEY_FILE` and `TLS_CERT_FILE`. Set
`PUBLIC_ORIGIN` to the exact HTTPS browser origin when using a proxy. All keys
stay on the server; never use a `VITE_*` key variable.

The implementation follows [OpenAI’s Live WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc)
and the repository’s Live references. The voice model is `gpt-live-1`; the
Responses backend defaults to `gpt-6-luna` with reasoning effort `none`.
It uses WebRTC and a server sideband for identity/reporting tools. No Twilio
connection is involved. Real model/account access and iPhone audio are checked
by the person’s voice test, not by the process health endpoint.

There is no application session-count budget or conversation-duration cap.
You can engage again after ending a channel. Provider session limits still
apply. There is no automatic retry/reconnect. Startup and shutdown timeouts
still clean up failed connections; they do not limit established conversations.
Restart/redeploy clears temporary reports. A stop sends `session.close`;
only `session.closed` confirms finalization.
Transcripts are not logged to the server. The Live creation endpoint rejects
the top-level `store` field, so this app does not claim to configure provider
recording or retention. Production sign-in and durable report storage remain future work.

## External service handoff

The officer captures a draft, reads it back, asks “Is that correct?”, and calls
`submit_report` after spoken confirmation. The recap is read-only; there is no
Save button. Only an external `context_id` receipt marks the report Recorded.
Unknown submission outcomes are retained without automatic retries.

## Verification

`npm test` exercises phrase matching, lockout, report gating, ownership,
report retention, cancellation, CSRF/origin guards, disabled Live and removed demo routes, duplicate
tools, Responses continuation, close confirmation, and static serving.
All provider transports are injected; tests make no OpenAI/Twilio calls.
The mobile and desktop UI are additionally checked through the browser.
Physical iPhone audio, Safari speech permissions, and real GPT-Live
conversation remain separate device/provider checks.

## Railway service

The reporting app has its own service, `hailing-frequencies-reporting`, in
the linked **Web Dev Challenge** project’s production environment. Its public
address is <https://hailing-frequencies-reporting-production.up.railway.app>.
The existing service is independent of this app. GPT-Live is enabled on this
deployment; the supplied key is held in Railway variables only. Railway’s HTTPS domain supports
the secure browser context needed for phone microphone access.

`Dockerfile` builds the app together with the parent design-system CSS,
runs the offline tests, and ships a non-root Node runtime. Build context must
contain `reporting-ui/` and `design-system/`; the Dockerfile-specific ignore
file excludes secrets, evidence, Git metadata, and other services. From the
repository root, local image verification uses:

```sh
docker build -f reporting-ui/Dockerfile -t hailing-reporting-ui:check .
```

This deployment was uploaded through Railway CLI from a sanitized source
bundle, not a GitHub auto-deploy. Future source changes need another upload.
Target project `1cce1273-8095-441e-bab8-464b5a1662bf`, environment
`438f97c6-7b64-4d99-9105-9a9d9105840d`, service
`1ad0824c-9d1e-4353-9a7d-032253b2273a` explicitly. Settings: Dockerfile
`reporting-ui/Dockerfile`, one replica in `us-west2`, `HOST=0.0.0.0`,
`PORT=8080`, `NODE_ENV=production`, `LIVE_ENABLED=true`, and `PUBLIC_ORIGIN`
equal to the HTTPS address above. Railway checks `GET /health` with a
60-second timeout and restarts on failure with three retries. The app needs
no database. Restarts/redeployments clear its temporary demo reports.

The new `reporting-ui` Sannr stack binds only this service’s health endpoint
using `docs/health.openapi.json`. It is distinct from the parent `app` stack,
which points at the existing companion. A readiness check must assert HTTP
200, `status=ready`, `service=reporting-ui`, `liveEnabled=false`, and
`externalDeliveryEnabled=false`; it does not test an audible Live connection.

## Real Railway workflow rehearsal

The [real rehearsal guide](docs/real-rehearsal.md) covers the local `rehearsal.html?mode=real` console. It connects the browser voice agent and manual controls to the main Railway CRM and four-question Decisions endpoint without a phone number. The offline `?mode=fixture` story remains available.

## CRM context and decision recommendations

Configure `REPORTING_API_TOKEN` and optionally `HF_BACKEND_URL` (defaults to
the context service host). The identity API must return the authenticated
caller's UUID as `crew_member_id`, either at the response level or in `profile`.
The server retains this ID; the voice model does not choose or infer it.

After spoken confirmation, the server posts exactly `{crew_member_id, context}`
to `/api/decisions`. The context contains the confirmed issue, location and
conversation, excluding authorization credentials. The external service owns
history lookup, case reuse/creation, classification and task persistence. The
reporting agent does not select cases or make routing decisions. Each POST is
a new submission, so duplicate tool calls for the same draft revision share
one result and uncertain requests are never retried automatically.

The service stores the context before classification. A receipt can therefore
mean Recorded even when no decision or expert route is available. The returned snapshot and decision are available in Debug; the Case Context
widget has been removed. Refresh clears all local conversation state.

## Expert MCP routing

An external `route_to_expert` action triggers expert dispatch after discovery
and validation of the exact advertised tool. The returned dispatch_key is claimed durably before tools/call, and the
projected receipt is persisted. Configure EXPERT_DISPATCH_DIR on a persistent
volume. Exclusive claims prevent concurrent/restarted clients from duplicating
work; reused handoffs read the saved receipt without redispatch. A claim with
no confirmed receipt remains unknown and is never automatically reclaimed. The reporting
server discovers `/mcp` tools and invokes the exact tool named in the returned
handoff, with the service's question and immutable context arguments. A missing
tool is reported as unavailable; another specialist is not substituted.
Configure `SPECIALISTS_MCP_TOKEN` and optionally `EXPERT_MCP_URL`.
Requests use stateless MCP 2026-07-28 metadata with no Tasks extension.
Stored answers, requests for more information and undecided responses do not
dispatch. Existing task reconciliation follows the service's dispatch policy.
No automatic retry follows a lost tools/call response.

The UI distinguishes expert answers, accepted investigations and unknown
outcomes. Refresh can collect an investigation when `expert_collect` is also
advertised. An expert failure does not erase a known context-storage receipt.
Answers are shown in the conversation; backend result persistence and callback
delivery remain separate.

## Preferred spoken language

Use PR #11’s `profile.preferred_language`: `english` keeps Marin; `klingon`
selects Cedar and requests Klingon spoken replies. The older `language` field
is not used as the preference. Tool names, IDs and stored records are unchanged.
Since Live’s voice is fixed at startup, a Klingon preference received after
identity confirmation triggers a media-session handover. The old Live session
must acknowledge closure before the new one starts; server-side identity,
CRM context and the channel remain intact. No second authorization is required.
Actual Klingon speech and iPhone audio require a device/provider check.

## Debug responses and undecided follow-ups

The collapsed Debug panel at the bottom shows the current conversation's
upstream HTTP response bodies from identity, Decisions, Live creation and MCP
discovery/calls. Entries include endpoint, method, status and timing. Credentials,
authorization phrases, session tokens and SDP are redacted; no request headers
or bodies are displayed. History keeps up to 20 entries and 2 MiB of body text,
with a 1 MiB per-response capture limit. Truncation and dropped entries are
shown explicitly. Earlier conversations cannot be reconstructed retroactively.

An undecided Decisions result makes the officer ask a specific follow-up, wait
for additional caller details, capture and confirm the expanded report, then
submit a new context. This repeats while the result remains undecided and the
caller continues. Duplicate tool calls for a revision do not repeat the POST.
SSE backpressure coalesces pending state rather than closing the channel.

Every page load resets the browser conversation through the protected /api/reset endpoint before opening the event stream. It closes the previous voice channel and clears identity, reports, decisions and debug history. Download a recap before refreshing if you need a local copy. Stored external CRM records are retained.
