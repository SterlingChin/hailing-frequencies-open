# Engineering SMS Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the engineering expert ask the configured user a question by SMS, pause, and resume its investigation with a text or picture reply.

**Architecture:** An engineering-only agent tool delegates to a single-slot context-request coordinator. A signed Twilio webhook acknowledges inbound messages promptly and schedules bounded media preparation; the coordinator resolves the pending tool only after sending succeeded and reply preparation completed. The existing agent run, workspace, dispatch ID and MCP task protocol are preserved.

**Tech Stack:** TypeScript, Node.js 22+, the existing OpenAI Agents SDK and MCP server SDK, Vitest, Twilio's Node SDK for REST/signatures, and Sharp for image metadata validation. Pin new dependency versions in package.json/package-lock.json during execution; verify Node 22+ and the Railway Linux runtime are supported before installation.

**Spec:** [Approved design](../specs/2026-10-12-engineering-sms-context-design.md).

## Global Constraints

- One configured recipient; never commit its number or credentials.
- Engineering investigation only; triage dispatches rather than sending SMS.
- One outstanding question, including sending and attachment preparation.
- Question at most 500 characters; webhook body at most 64 KiB.
- At most 3 images, each at most 5 MiB and 20 megapixels; JPEG, PNG and WebP only.
- Media download timeout 15 seconds; default configurable reply timeout 30 minutes.
- No automatic error SMS or blind retries of uncertain sends.
- Waiting stops model calls and workspace commands; cancellation releases resources.
- Keep MCP task wire statuses unchanged and protocol revision 2026-07-28.
- Ephemeral state, one Railway replica; restarts end investigations and waits.
- No Twilio/OpenAI traffic in tests. Live smoke tests require an approved concrete SMS.
- Read the repository README, API prep guide, operation-specific Sannr notes and relevant BUGS.md before provider requests. Select stack/environment explicitly. Historical notes are not account verification.

## Review Focus

1. A reply arrives before outbound acceptance: buffer it, but do not resume before sending succeeds (Task 2).
2. Cancellation occurs while attachment download completes: a stale completion must not resolve a later request or write into a removed workspace (Tasks 2, 3, 5).
3. A signed MMS contains one valid and one invalid attachment: do not resume with silently incomplete context; leave the wait active for a replacement reply (Tasks 3, 4).
4. The model emits parallel context/shell calls: while asking the user, block additional workspace execution rather than allowing parallel tool calls to defeat the pause (Task 5).
5. Reply timeout exceeds configured task TTL: reject startup configuration that can expire collection tasks before the supported waiting interval ends (Tasks 1, 5).

## File and interface map

Create `src/context/types.ts` for cross-component interfaces, `src/context/config.ts` for private settings, `src/context/twilio-client.ts` for outbound messaging, `src/context/requests.ts` for wait lifecycle, `src/context/media.ts` for authenticated attachment preparation, `src/context/webhook.ts` for inbound HTTP validation, and `src/experts/user-context.ts` for the internal agent tool and workspace persistence.

Modify `src/config.ts`, `src/index.ts`, `src/http.ts`, `src/server.ts`, `src/experts/dispatch.ts`, `src/experts/triage.ts`, `src/experts/investigator.ts`, `src/experts/local-workspace.ts`, `src/tools/index.ts`, `src/tools/results.ts`, README.md and .env.example. Tests mirror these components under `test/unit/` plus a new `test/integration/engineering-context.test.ts`.

Shared types in `src/context/types.ts`:

```ts
type WaitStage = 'sending' | 'waiting' | 'working';
type ReplyImage = { bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' | 'image/webp' };
type PreparedReply = { messageSid: string; text: string; images: ReplyImage[] };
type InboundReply = { messageSid: string; accountSid: string; from: string; to: string;
  text: string; media: { url: string; declaredMime: string }[] };
interface QuestionSender {
  sendQuestion(question: string, signal: AbortSignal): Promise<{ messageSid: string }>;
}
interface ReplyPreparer {
  prepare(reply: InboundReply, signal: AbortSignal): Promise<PreparedReply>;
}
type ContextOutcome = { kind: 'reply'; reply: PreparedReply } |
  { kind: 'busy' | 'send_failed'; message: string };
interface ContextRequests {
  request(args: { dispatchId: string; question: string; signal: AbortSignal;
    onStage(stage: WaitStage, safeMessage: string): void }): Promise<ContextOutcome>;
  acceptReply(reply: InboundReply): 'accepted' | 'duplicate' | 'ignored';
  dispose(): Promise<void>;
}
```

Timeout and abort reject `request`; they must end the investigation rather than allowing a model to continue after its wait expired. Busy/send failure return explicit outcomes. All messages projected to MCP omit phone numbers, credentials and message bodies.

### Task 1: Configuration and outbound messaging

**Files:** Create context/types.ts, context/config.ts, context/twilio-client.ts; modify src/config.ts, package.json, package-lock.json, .env.example; create test/unit/context-config.test.ts and twilio-client.test.ts.

**Interfaces:** `loadContextConfig(taskTtlMs: number): ContextConfig | null`; `createTwilioQuestionSender(config: ContextConfig, client?: TwilioMessagingTransport): QuestionSender`. `TwilioMessagingTransport.createMessage({to, from, body}, signal): Promise<{sid:string}>` is the injectable boundary; define it in twilio-client.ts. Keep secret-bearing ContextConfig out of AppConfig and logs.

- [ ] Write failing tests for disabled integration, missing required settings, invalid E.164 numbers, incomplete API-key pairs, non-HTTPS origin, and timeout/TTL mismatch. Assert `loadContextConfig(60_000)` rejects a configured 1_800_000 ms wait.
- [ ] Write sender tests that assert the resulting message uses only configured From/To, rejects questions over 500 characters before transport, and reports rejection without retrying. Capture transport inputs in a fixture; never assert only that a mock exists.
- [ ] Run `npm test -- test/unit/context-config.test.ts test/unit/twilio-client.test.ts`; confirm failures describe missing behavior.
- [ ] Implement settings: `EXPERT_CONTEXT_ENABLED=false`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, optional `TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET`, `EXPERT_CONTEXT_FROM`, `EXPERT_CONTEXT_TO`, `EXPERT_CONTEXT_PUBLIC_ORIGIN`, `EXPERT_CONTEXT_REPLY_TIMEOUT_MS=1800000`. Require task TTL to exceed reply timeout by at least the 15-second media budget. Validate an origin has no path/query/fragment. Retain only booleans in public configuration.
- [ ] Install compatible pinned Twilio/Sharp dependencies; keep client autoRetry disabled and bound outbound REST time to 8 seconds. Honor AbortSignal at the wrapper boundary; ignore late results after cancellation and do not retry an uncertain submission.
- [ ] Run the focused tests and `npm run typecheck`; commit only this task's files with `feat: configure engineering SMS questions`.

### Task 2: Single outstanding request coordinator

**Files:** Create src/context/requests.ts and test/unit/context-requests.test.ts.

**Interfaces:** `createContextRequests({sender: QuestionSender, preparer: ReplyPreparer, replyTimeoutMs: number}): ContextRequests`. Consume Task 1 types; no SDK, HTTP, filesystem or credentials in this component.

- [ ] Write deferred-promise tests for reservation-before-send, busy rejection, early replies, acceptance-before-waiting, sequential questions, and definitive/ambiguous send failure. Assert an early prepared reply leaves the request unresolved until send acceptance.
- [ ] Write race tests for cancellation/timeout during send and preparation, duplicate MessageSid, unsolicited messages, preparation failure followed by a replacement reply, disposal, and stale completion after a new reservation. Assert exactly one resolution and no resurrection; use fake timers for the 30-minute default.
- [ ] Run `npm test -- test/unit/context-requests.test.ts` and confirm failures.
- [ ] Implement a reservation identity plus AbortController, one deadline, and a process-lifetime seen-SID Set. `acceptReply` starts preparation asynchronously and returns immediately; consume all rejections. Ignore additional concurrent replies while one is preparing. On preparation failure keep the reservation waiting, but permit a different MessageSid retry. Transition to working only once both successful outbound acceptance and a prepared reply exist.
- [ ] Run focused tests and typecheck; commit `feat: coordinate engineering context waits`.

### Task 3: Bounded image preparation and workspace viewing

**Files:** Create src/context/media.ts and test/unit/context-media.test.ts; modify src/experts/local-workspace.ts and test/unit/local-workspace.test.ts.

**Interfaces:** `createReplyPreparer(config: ContextConfig, fetchImpl?: typeof fetch): ReplyPreparer`; `inspectReplyImage(bytes: Uint8Array): Promise<ReplyImage>`. Add SDK-compatible `materializeEntry(args)` and `viewImage(args)` to LocalWorkspaceSession. Filesystem paths use the existing workspace containment and regular-file checks.

- [ ] Write image fixtures for real JPEG/PNG/WebP and tests for spoofed MIME, corrupt bytes, oversized payload/dimensions, more than 3 images, unsupported formats, chunked-body overflow, stalled reads and abort. Assert 5 MiB and 20 megapixel boundaries explicitly.
- [ ] Write URL tests for another account/message, non-HTTPS origins, embedded credentials, and redirects to untrusted origins; assert no credential-bearing request reaches an unapproved destination. A failure on any attachment rejects the whole reply.
- [ ] Run `npm test -- test/unit/context-media.test.ts test/unit/local-workspace.test.ts` and confirm new failures.
- [ ] Implement a 15-second deadline covering all downloads per reply, bounded streamed reads, and actual-format/dimension checks using Sharp metadata with no unbounded pixel decode. Accept initial media URLs only under the configured account and incoming MessageSid. Reject redirects by default; add a Twilio-owned media redirect allowlist only after verifying the documented endpoint behavior, and strip authentication on any cross-origin request. Never blindly follow redirects.
- [ ] Implement bounded local `viewImage` returning the SDK's ToolOutputImage, and `materializeEntry` supporting only file/dir entries. Test real file content plus image mediaType/base64 output, unsupported entries and traversal/symlink rejection. Use direct filesystem writes, not agent-generated shell commands.
- [ ] Run focused tests and typecheck; commit `feat: prepare and inspect SMS image replies`.

### Task 4: Signed Twilio inbound webhook

**Files:** Create src/context/webhook.ts and test/unit/context-webhook.test.ts; modify src/http.ts; add HTTP integration coverage in test/integration/engineering-context.test.ts.

**Interfaces:** `createEngineeringContextWebhook(config: ContextConfig | null, requests: ContextRequests | null): (req: IncomingMessage, res: ServerResponse) => Promise<void>`. It produces validated InboundReply values for Task 2.

- [ ] Write signed form-body fixtures using Twilio's official signing helper. Test exact public URL, all form fields including unknown fields, invalid signature, wrong account/From/To, invalid SID, malformed NumMedia, empty context, oversize body and disabled integration. Assert no unauthenticated payload reaches acceptReply.
- [ ] Add real HTTP tests proving valid replies receive `<Response/>` promptly while a deferred image preparer remains pending; no MCP bearer header is required. Duplicate/late/unsolicited valid replies receive empty TwiML without sending an SMS. Assert the existing MCP endpoint still requires its bearer token.
- [ ] Run `npm test -- test/unit/context-webhook.test.ts test/integration/engineering-context.test.ts`; enable local listener permissions if the sandbox blocks them.
- [ ] Implement form decoding with the 64 KiB limit and signature validation before context processing. Derive the validation URL from the configured origin and exact request path; do not trust proxy headers. Invalid signatures or identity fields return 403, malformed inputs 400, oversized body 413, disabled integration 503. Empty/unsupported replies do not complete a wait. Route the webhook before the MCP-path 404 branch; keep its asynchronous work owned by the coordinator.
- [ ] Run focused tests and typecheck; commit `feat: accept signed engineering SMS replies`.

### Task 5: Engineering agent integration and observable lifecycle

**Files:** Create src/experts/user-context.ts; modify investigator.ts, triage.ts, dispatch.ts, local-workspace.ts, src/server.ts, src/index.ts, src/tools/index.ts, src/tools/results.ts; extend dispatch/tools tests and engineering-context integration tests.

**Interfaces:** `buildUserContextTool({dispatchId, session: SandboxSession, requests: ContextRequests, signal, onStage}): FunctionTool`. Add optional contextRequests dependency to ExpertServerDependencies and ExpertDispatchServiceOptions. Extend `buildInvestigatorAgent` with an optional engineering context tool. Extend DispatchStatus with `waiting_for_user`, and snapshot metadata with optional `waitingSince` (no SMS content/identifiers).

- [ ] Write a scripted engineering flow: triage dispatches, investigator calls request_user_context, sender accepts, status becomes waiting_for_user, signed text reply arrives, next model step observes reply text, and final report completes under the same dispatch ID/workspace.
- [ ] Add image flow: scripted investigator asks for context, receives an image path, calls view_image, and the next model request contains actual image content. Inspect SDK model request items; a path string assertion alone is insufficient.
- [ ] Test no request_user_context tool during triage or for other experts, disabled integration behavior, capacity counting while waiting, live expert_status/expert_collect, cancellation, timeout, and shutdown cleanup. Assert collection stays a protocol working task while its status message says waiting for user.
- [ ] Add a model fixture emitting parallel context and shell calls; prove no shell command begins while the context wait is active. Apply SDK modelSettings `parallelToolCalls:false` and enforce an explicit per-investigation workspace execution gate, so model compliance alone is not the guard. The gate permits server-side reply persistence and releases on resume/abort.
- [ ] Run affected tests and confirm new cases fail. Implement the tool with a 500-character schema, abort propagation, server-generated safe attachment names under request/replies/, and persistence before returning reply text/paths. Do not allow the model to pick recipients or destination paths.
- [ ] Update activeCount, waitFor, cancel/dispose, progress subscriptions and result switch statements for the new nonterminal state. Preserve the consultation's existing dispatch behavior, early cancellation protections and process cleanup. Compose webhook, coordinator and messaging dependencies in index.ts; dispose coordinator before waiting for stopped investigations.
- [ ] Run `npm run verify`; all unit/integration tests, typecheck, lint and build must pass. Request independent review of lifecycle, credential handling and image-input integration; fix important findings and rerun affected checks. Commit `feat: resume engineering investigations from SMS context`.

### Task 6: Operator documentation, wiring and deployment

**Files:** Update README.md and .env.example; create docs/engineering-sms.md. Private configuration stays in ignored files/Railway variables.

- [ ] Document settings, webhook URL, truthful send/wait states, supported images/limits, one outstanding question, ambiguous delayed replies, timeout, restart loss, one replica, and explicit instructions for reconnecting Inspector. Provide no real phone numbers or credentials.
- [ ] Inventory configured credential names and sender candidates without printing values. The latest read found no populated Twilio credential names in this package's .env or the parent .env; the user's stated key may be elsewhere or in Railway. Resolve its actual location rather than borrowing preparation-repository credentials. Obtain the sender number and account Auth Token if missing.
- [ ] With the explicit `twilio` production stack, retrieve notes for number reads and the selected number-update operation before inspecting current sender capabilities/webhook configuration. Determine SMS/MMS capability and account-specific sending eligibility; do not infer them from imported Trial reports.
- [ ] Present the exact sender, existing webhook, proposed webhook `https://web-dev-challenge-production.up.railway.app/webhooks/twilio/engineering-context`, and any credential transfer for necessary approval. Preserve another application's handler or choose a dedicated sender. No callback mutation occurs merely to discover configuration.
- [ ] Run `npm run verify`, inspect the final diff for secrets/unrelated edits, and confirm .env/.data/raw evidence remain ignored. Deploy to the existing Railway project/service with integration explicitly configured and a single replica. Do not claim completion until the submitted deployment ID reports SUCCESS.
- [ ] Check health, authenticated MCP catalogue and an unsigned webhook rejection through a correctly scoped Sannr binding. These checks must invoke no models or send SMS. Inspect captured assertion receipts rather than generic verification counters.
- [ ] If the user approves a concrete smoke-test question, run one engineering dispatch and have the user reply by SMS/MMS. Verify waiting then resumed status and the final report; record actual failures without additional unapproved sends. Otherwise report that offline behavior and deployment were verified, but delivery/real MMS remain unverified.
- [ ] Commit documentation and nonsecret wiring changes as `docs: operate engineering SMS follow-ups`; record reusable provider findings with existing evidence and read them back under the Sannr write convention. Do not duplicate response shapes or probe solely for bookkeeping.

## Plan self-review

Coverage: Task 1 owns configuration and sending; Task 2 owns wait state and races; Task 3 owns media restrictions and actual image inspection; Task 4 owns signed HTTP ingestion; Task 5 owns engineering-only tools, task/dispatch behavior and cancellation; Task 6 owns private configuration and production verification. Every Review Focus item has an explicit test in its owning task. No durable infrastructure, arbitrary recipients, other-expert SMS capability or unsolicited outbound messages are added.

## Execution handoff

Review this plan before implementation. Recommended approach: native execution in this chat, followed by independent review; the six tasks depend closely on the same coordinator and dispatch interfaces. Subagent-driven execution is also available, with fresh implementation/review contexts for each task. Deployment and a live smoke test are separate validation stages with the concrete sender/credential/message approvals described above.
