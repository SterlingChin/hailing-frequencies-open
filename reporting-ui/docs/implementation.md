# iPhone communicator

Approved scope: a simple Vite app for iPhone 12, using a demo crew profile,
an Engage button, the greeting “Hailing frequencies open,” spoken identity
confirmation, issue capture, and a recap. External delivery is deferred.
The user approved building this design on October 12, 2026.

Use vanilla JavaScript and the parent design system. A Node server serves
Vite in development and the built app in production, plus same-origin APIs.
The server owns demo phrase validation, three-attempt lockout, and report
state. This is fictional profile confirmation, not real authentication or
voice biometrics. Demo mode uses browser speech with a typed fallback;
Live mode uses GPT-Live WebRTC and a server sideband for Responses tools.
Keys stay on the server. Live is disabled by default and uses an explicit
session count and duration cap. No provider calls are part of build tests.

Implementation, executed inline:

- [x] Test identity rejection, phrase variants, lockout, capture gating,
  draft edits, isolation, and faithful not-sent status; implement reporting.
- [x] Test disabled Live, server-only configuration, tool events, duplicates,
  and shutdown with injected transports; implement same-origin API/server.
- [x] Build safe-area mobile communicator, captions, explicit demo/Live modes,
  identity help, speech/typed input, transcript, report editing and download.
- [x] Run offline tests and build; inspect narrow mobile and desktop layouts and
  complete demo flow. Document HTTPS setup and Live verification limits.

Review focus: cancellation while microphone permission is pending; stale
speech callbacks; denied/unsupported speech; sideband failure and startup
timeout; stopping and re-engaging without carrying demo authorization into
a new channel. No transcript, authorization phrase or provider error body
is written to server logs. Reports remain in memory until server restart;
downloads are explicitly requested by the user.

Final implementation keeps reports independently from channel authorization,
selectable under Saved reports. A demo session lasts up to one hour; restart
also clears in-memory state. Save responses retain newer unsaved edits, and
channel IDs isolate late begin/stop/ready/message requests. Browser permission
cancellation releases eventual microphone tracks without creating a session.

Verification on October 12: 19 offline tests passed; Vite production build
passed. Browser checks of the built app covered greeting, identity confirmation,
issue capture, review, JSON download (read back with delivery=not_sent), channel
end, identity reset, report retention/selection, and disabled Live. Narrow
layout measured 391 CSS pixels with no horizontal overflow; desktop uses the
bridge zones. Earlier browser demo check rejected an incorrect phrase. No real
provider session, credential use, deployment, push, or physical iPhone audio
test took place during the initial local build.

The user subsequently authorized a new Railway service in the linked project.
Created `hailing-frequencies-reporting` in Web Dev Challenge / production,
service `1ad0824c-9d1e-4353-9a7d-032253b2273a`. Deployed a sanitized source
bundle with shared CSS and a Dockerfile that ran all 19 tests and the Vite
build. Deployment `77862284-f7b2-47a6-9653-5bbd32a358a1` reached SUCCESS.
Railway's /health probe passed; a public Sannr GET /health returned 200 with
five passing assertions (evidence `run-49bb9836-a351-40c6-9b18-32471ed82687`).
Live and external delivery were disabled. Hosted browser verification passed
greeting, demo phrase confirmation, issue capture, and end-channel retention,
with no console warnings/errors. Existing services were not changed. No
OpenAI/Twilio requests, real sign-in, Git push or physical iPhone test occurred.

## Live-only follow-up

The user supplied a test key and authorized setting it in Railway. The key
was written directly through Railway’s variable tool, not saved in the
checkout. Live was enabled with one attempt per process and 120 seconds.
An enabled-service health check passed five assertions; no paid Live session
was initiated by the agent. The user then requested removal of the scripted
demo path and toggle. The UI now opens GPT-Live directly, removes browser
speech/typed-demo input, and retains the explicitly fictional crew profile.
The API rejects demo-mode creation and no longer exposes /api/demo/message.
All 19 offline tests and the Vite build passed for this change. Reports and
session cancellation retain their earlier protections.

Final Live-only deployment a7d4629f-2257-47a0-8f37-898fb761ee9e reached SUCCESS. Production /health passed all five assertions with liveEnabled=true and externalDeliveryEnabled=false (run-96b5e397-7f23-4766-a3fe-5ebf53725a0c). Hosted browser showed no mode toggle, an enabled Engage button, and no console warnings/errors. No paid provider session was opened by the agent.

## Remove test limits

At the user’s request, removed process-wide attempt counting, the 120-second
application conversation timer, the UI reset-budget message and disable
condition, and process-wide single-call gating. Per-browser active-channel
checks remain to prevent overlapping channels in the same session. Idle
cleanup skips active conversations; the cookie no longer expires after a
fixed hour. Recent tool-call IDs are bounded without closing conversations,
and recent recap retention evicts old reports without preventing Engage.
Startup/shutdown failure cleanup and provider limits still apply.
22 offline tests passed, including 105 channels with reports, a conversation
past the old timer and 1,100 tool calls without termination.

The final deployment 580a7bb4-28b3-4633-aec3-74af2c264a3b reached SUCCESS with no pending Railway work. Browser verification reproduced the old blocked button, then confirmed the refreshed page enables Engage and omits the test-budget message. Production health passed five assertions (run-f1846c81-acb4-4200-996d-e1637686c45d). No paid voice session was started by the agent.

## Live startup correction — October 12

Corrected data-channel server event permissions to selector objects. A scoped
Railway-key test observed HTTP 400 for unsupported top-level `store:false`;
removing it returned HTTP 201 (run-3411e951-315a-4d9b-8889-2537be53e4ad).
Read-only model checks returned 200 for both configured models. Creation does
not verify audio playback or delegation. The later sideband cleanup attachment
returned 404; no session.closed acknowledgment was observed. Temporary local
credential material was removed. Safe startup diagnostics now distinguish
invalid configuration, credentials, access, quota, throttling and transport
failures without exposing raw provider messages. All 24 offline tests passed,
and the Vite production build passed.
Deployment 9d26b869-e20f-4994-a3bb-c38bd463fe85 reached Railway SUCCESS.
Public health returned 200 and passed four assertions with Live enabled and
external delivery disabled (run-bb8426da-1746-4469-b887-d645a9e82576).

## Crew profile wording — October 12

Removed the demo-profile badge, authorization-help label, status/recap copy,
and agent greeting wording. The officer now welcomes Commander Chen without
calling the profile a demo; the identity tool returns profile_loaded. Kept the
single configured Avery Chen profile and phrase matching. No second profile
or new authentication method was added. All 24 tests and production build pass.

## Fixed authorization phrase — October 12

Avery Chen uses: Authorization, Chen, Avery. Alpha seven, Bravo nine, Echo two.
Updated the displayed hint and server phrase, normalized Bravo and Echo plus
spoken digits, and derive validation from PHRASE to prevent hint/validator
mismatch. Tests accept spoken words, digits and CHEN-AVERY-A7B9E2; the old
phrase is rejected. All 25 tests and the production build passed.

## Caller-context integration — October 12, awaiting provider rollout

Uses a server-only client and one identity lifecycle per voice channel. Calls
start with an empty JSON object after Live readiness and greeting submission
(which does not prove greeting playback); serializes delegated tool calls;
sends session_token,name,authorization_phrase to authorize per user-confirmed
API change; uses returned display_name/rank/profile for replies and recaps.
No local runtime authorization fallback. Closes context on stop/provider close,
and cleans up sessions created after cancellation. Expired contexts fail closed.
31 mocked/offline tests and Vite build pass. No live identity requests or
integration deployment yet: colleague’s provider changes and Railway token
configuration must be ready. Checked-in API still uses spoken_phrase.

The user confirmed provider readiness and authorized proceeding on October 12.
The shared CONTEXT_API_TOKEN was configured on the reporting Railway service
because readback showed it missing; the credential is not stored in source.
A subsequent source deployment includes the configured variable. 32 offline
tests pass, including editing an owned recap after voice authorization expires.
Deployment 6f02f9c6-c902-4eef-b3c2-959607eb2191 reached Railway SUCCESS.
Real voice/identity-service conversation still requires the user’s device test.

## Browser session recovery — October 12

Redeployments discard in-memory browser sessions, while already loaded tabs
retain their old cookie and CSRF token. Previously Engage surfaced Session
expired. API now returns a distinct browser_session_reset code before action
processing; client obtains a fresh session and retries that rejected request
once. Concurrent recovery shares one bootstrap and provider failures never
trigger a retry. 35 tests and Vite build pass.

## Live CRM context and Decisions integration — October 12

Read the reporting and Decisions server contracts and existing real-data
rehearsal adapter. Added a separate server-only CRM reporting client/session;
load_crew_profile receives the actual authorized phrase, never a seeded phrase.
Agent tools select/create cases, refresh context, update symptoms, record
explicit outcomes/close requests, and call /api/decisions for the selected case.
Caller-context session tokens are never substituted for reporting tokens.
Context and decision snapshots flow over existing browser-owned session/SSE.
Added Case context panel with equipment, existing/recent cases, selected issue,
queue and backend decision, plus manual refresh. Display working as pending
with no execution confirmation; display backend queue reuse and stored answers
truthfully. No expert adapter, callback or messaging integration was added.
Context expiry applies to manual refresh too; late-start sessions are closed.
54 local tests pass and production build passes. Runtime token configuration
and production rollout pending; no new live Decisions request made by the agent.

User authorized reusing CONTEXT_API_TOKEN for REPORTING_API_TOKEN. Client uses
that shared value unless REPORTING_API_TOKEN overrides it. Production reporting
start with the shared value returned 401 unauthorized (run-d2a929a9-4b07-4447-8195-add12f3ff393).
No reporting session or paid Decisions request was created. Integration now
refreshes CRM after a decision, because the decision’s context snapshot can
precede the newly queued task. 55 offline tests and production build pass.
Provider token alignment remains required; user was notified of the actual 401.
Final deployment c82e7c15-bfd6-4b84-a7ca-b20699ff6cf7 reached Railway SUCCESS.
The running app passed its public health assertions. Live reporting context
remains blocked by the provider’s rejection of the shared credential; this
was not misreported as verified end-to-end integration.

## MCP expert routing — October 12

Authenticated production tools/list returned maintenance only, with question
and optional context; no expert was invoked during agent verification. Added
server-only stateless MCP2026 client, required metadata, discovery-first
routing for fresh queue decisions, task-id deduplication, no IT fallback,
no automatic dispatch retries. Full safe decision CRM context is captured
before the post-decision refresh and passed as context; credentials remain in
server headers. Nonqueue outcomes use CRM/stored answers or request more details.
UI shows requesting/answer/dispatched/working/unknown states separately. Only
an ANSWERED.answer or completed.report becomes an answer. Expert collection
requires a discovered expert_collect tool, absent from the current catalog.
No result-writeback endpoint or callback transport added. 60 offline tests and
Vite build pass. Shared live MCP token configured on reporting service privately.
Review fixes clear expert answers on case/symptom changes and check channel
cancellation immediately before tools/call. Late replies to already-issued
calls are retained without duplicate dispatch. 62 tests and build pass.

## Custom domain origin — October 12

Set Railway PUBLIC_ORIGIN=https://federation.support. Deployment
3e9e3dbf-7025-4f70-9fc6-9e54f207bb08 reached SUCCESS. Sannr GET
/api/session on the custom domain returned 200. A sessionless POST with
Origin federation.support passed the origin guard and returned the expected
401 browser_session_reset at the subsequent session guard (two assertions,
run-9bc77dfd-a181-4ffb-ace5-682a3e455aa5). No Live/provider traffic.

## Voice confirmation / decision before recording — pending API contract

User requires spoken readback “Is that correct?” followed by decision BEFORE
recording the reported issue in CRM and dispatching the expert. Removed local
Save review controls; recap is read-only and download no longer invokes a save.
62 offline tests/build pass. Not deployed: existing /api/decisions requires a
selected CRM case and applies routing/queues before returning. Requested the
decision-only endpoint/mode contract from the user; do not fake this ordering
by recording first or relabeling the existing endpoint. Voice submission tools
must be gated to the confirmed readback and use the forthcoming decision-only
contract, then record and dispatch in that order.

## PR11 preferred language / voice handover — October 12

Read merged PR11: preferred_language enum english/klingon, separate from legacy
language. English/missing preference selects Marin, Klingon selects Cedar.
Current official Live create documentation confirms voice/instructions fixed
at startup. After identity/CRM profile loads, pause backend continuation while
frontend renews WebRTC media; preserve shared identity and CRM controllers,
wait for session.closed, and start the new Live session with the preferred
voice and language instructions. No manual reload/re-authorization required.
Scoped /api/live/voice retains channel/CSRF/origin ownership. Switching blocks
Begin; retired transport errors/frames cannot end the replacement session.
Tests cover language selection, preserved authorization, close timeout, stale
requests, duplicate switches, cancelled switches and retired socket events.
67 offline tests and Vite build pass. No live OpenAI speech test performed.
External-service-owned report submission workflow remains pending its API
updates; no new local case/decision workflow added for this language change.

## Trusted intake after PR #12

The current Live tool set is authorize_caller, capture_issue and submit_report.
After the caller confirms the readback aloud, the server submits the trusted
identity UUID and conversation to /api/decisions. Case and routing decisions
belong to the external service. Only its route_to_expert action can trigger
an MCP invocation, and the named tool must be advertised without substitution.
The recap has no manual Save control. A context_id receipt means Recorded even
if subsequent classification or expert dispatch fails. Duplicate draft-revision
submissions share one result; unknown outcomes are not retried automatically.

The requested Avery Chen identity check returned authorized with English as
the preference but no crew_member_id. The user is arranging that API update
and authorized publishing while it deploys. Missing UUIDs stop intake before
any Decisions POST; no seeded or name-derived ID is substituted.

Reviewed implementation passed all 78 offline tests and the Vite production
build. Railway deployment 010c54ef-75df-4483-b060-eb3c1d476582 reached SUCCESS.
The custom-domain health endpoint returned HTTP 200, ready, with Live enabled.
No real voice conversation or Decisions submission was initiated for deployment
verification; full intake depends on the identity UUID API update.

## Debug panel and undecided conversation loop

Added a collapsed Debug panel with raw upstream HTTP response bodies, status,
endpoint and timing, scoped to the current browser conversation. Secrets,
phrases, session tokens and SDP are redacted, including tokens echoed in text.
History/capture limits are explicitly labeled. Slow SSE clients now retain
only the latest pending snapshot until drain instead of being disconnected
or accumulating unbounded snapshots. Undecided results include a tool-return
follow-up instruction; the officer gathers additional caller details, captures
and reads back the updated draft, and resubmits after new spoken confirmation.
This continues without a round limit while the caller participates.
The brand subtitle is now “We actually want to help you...”.

84 offline tests and the production build passed; focused review found no
remaining issues. Deployment 91a713f5-f6a4-4193-915f-34de9dd9a70b reached SUCCESS.
Custom-domain health passed three assertions. A fresh browser tab verified the
subtitle, collapsed Debug by default, and expanded empty-state text. No paid
voice session or real Decisions submission was made for these checks.

## Refresh reset and main integration

Removed the complete Case Context widget. Each page load now performs a
protected reset before opening SSE: old channel shutdown, cleared identity,
reports, decisions and debug history, with rotated browser CSRF. Old pending
creation responses cannot stop a replacement channel. 86 UI tests and build
passed. Deployment a46052d3-2e2a-4ece-87b9-1ed50b4ef674 reached SUCCESS and
custom-domain health passed.

Merged origin/main through PR #13 without conflicts, retaining UI work.
Merged Decisions requires durable dispatch claims, which the in-memory expert
router does not provide. The initial PR gated new action handoffs pending durable storage. The user
rejected that restriction; it was removed before merge. New handoffs execute
after exact tool discovery and validation, with process-local deduplication.
Durable claim/receipt storage remains a follow-up. This temporary PR gate was
not included in the deployed refresh-reset build.

Implemented the merged main contract: persistent exclusive dispatch_key claims
are synced before MCP execution; projected receipts are saved atomically.
Reused tasks restore their receipt, and claimed calls without a receipt remain
unknown without replay. Railway now mounts reporting-expert-dispatches at
/data and configures EXPERT_DISPATCH_DIR=/data/expert-dispatches. The Docker
entrypoint initializes that directory and drops to node before serving.
At the user's request, no further tests are run and Docker builds only compile
the app, without invoking the test suite.
