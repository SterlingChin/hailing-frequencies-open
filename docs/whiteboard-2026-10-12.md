# Whiteboard, October 12, 2026: Sterling's side

**Latest architecture:** [IT/Maintenance routing and shared CRM context](routing-context-2026-10-12.md) supersedes the flow and next steps below. Reporting handles the initial call; IT/Maintenance own callbacks. Context is shared with Live, Decisions and the specialist, pending work is reused, and a confirmed closed case can supply an answer without reopening. The older sections below retain the history of the first probe and rehearsal; Access/Expert routing and the reporting-agent callback are no longer the target architecture.

From the October 11 notebook sketch. Michael owns identity, reporting and the MCP servers; this page is the other half: context, decision, queue, reply. Everything listed as built was written on the night of October 11 and passed the offline suites and the Postgres contracts. The October 12 Decisions probe and its limits are recorded below.

## The flow, Sterling's boxes

```
caller says what they need (voice now; SMS later)
  │
  ▼
CONTEXT    context/bundle.mjs       safe profile + selected case brief + the caller's words → one text block
  │                                 phone numbers withheld; fixed budgets; under 2 KB
  ▼
DECISION   decisions/               POST /v1/decisions on gpt-6-luna, four fixed questions
  │                                 route · resolvable_now · needs_more_details · urgency
  ├─ needs_more_details ─► officer asks one question, routes again
  ├─ solution           ─► officer answers on the call
  └─ queue              ─► "The access desk has it. Call or text at this number when it's ready?"
                              │
                              ▼
QUEUE      specialist_tasks     task bound to case + symptom revision; route = access | maintenance | expert
                                reply consent stored on the task: channel + the signed caller number only
                              │
                              ▼
MCP        queue/worker.mjs     specialists[route](payload) → bounded result       ← Michael's servers plug in here
                              │
                              ▼
REPLY      reply/sms.mjs        text the result (reuses the SMS claim/no-retry path)
           reply/call.mjs       place a call back; one-time ticket into the same bridge
                                officer asks for the authorization phrase BEFORE saying anything
                              │
                              └─ solution, or more details → back to CONTEXT on the return call
```

The box labelled "Clef" on the sketch is this Decisions API. Write "Decisions API" on the board; Clef is also an unrelated TypeSafe product.

## Demo beat, Sciences

Lieutenant in Sciences calls, gives the phrase, says the science report won't open. Officer confirms the existing case and calls `route_request` with their words. The October 12 fake rehearsal supplies route access, not resolvable now, routine; elevated urgency needs stated duty impact. Officer: "The access desk has it. Do you want a call or a text at this number when it's ready?" Caller says text and confirms this number. Officer calls `request_reply`. Call ends. The access handler returns "clearance lapsed at transfer; 24-hour pass issued." The worker records it and texts it. A faster handler may finish before consent; the saved result waits for the caller's reply request. Returning-call variant: caller says call, the call reply places an outbound call, the officer opens with "returning your call, authorization phrase please," then confirms the case and reads the result.

## What is built (October 11)

| Piece | Where | State |
| --- | --- | --- |
| Context bundle | `context/bundle.mjs` | Done. Tested for phone-number withholding and budgets. |
| Question set + thresholds | `decisions/questions.mjs` | Current thresholds: needs_more_details 0.75 (updated after follow-up-loop review), resolvable_now 0.6, expert route confidence strictly above 0.50 takes priority; existing issue-match confidence 0.40. Earlier probe records below retain their original thresholds. |
| Decisions client | `decisions/client.mjs` | Done. No retry, validates answers, never logs bodies, disabled without a key. |
| Decision step | `decisions/step.mjs` | Done. Context → decision → `startTask`. Provider failure returns undecided, never throws. |
| Call tools | `crm/tools.mjs` | `route_request` and `request_reply` added. Return calls reveal the result only to the matching profile, after the phrase. |
| Queue routes | `db/migrations/002_routes_and_replies.sql` | access, maintenance, expert added beside engineering and logistics. Reply consent and claim columns on the task. |
| Reply consent + delivery records | `crm/service.mjs` | `recordReplyConsent`, `prepareTaskReply`, `claimTaskReply`, `recordTaskReplyOutcome`, `beginReplyInteraction`, `listRepliesDue`, `getTaskAssignment`. |
| Worker | `queue/worker.mjs` | Runs an injected specialist handler, records the bounded result, delivers the reply, sweeps due replies. |
| Text back | `reply/sms.mjs` | Done. Shares the claim/no-retry send with the repair follow-up. |
| Call back | `reply/call.mjs`, `voice/server.mjs` | Done. `registerCallback` issues a ten-minute single-use ticket; `POST /outbound-call?ticket=…` is signature-checked against the exact URL and bound to the callee. |
| Flags | `voice/config.mjs` | `DECISIONS_ENABLED` (needs the OpenAI key). `CALLBACK_ENABLED` (needs `VOICE_ENABLED`, `TWILIO_VOICE_FROM`, database). Both off by default. |
| App wiring | `app/server.mjs` | Decision step into the bridge; worker runs in-process when `route_request` queues; `/health` reports both flags. |

Test totals with a loopback Postgres: voice 37, CRM 49, app 7, SMS 5, decisions and queue 9. Zero failures.

## What I hand Michael, and what I need back

The seam is `options.specialists` in `app/server.mjs`: an object keyed by route. Each value is `async (task) => ({ ok, result })`.

- **He receives** `getTaskAssignment` output: task id, case id, specialist, assignment (urgency prefix plus the caller's words), symptom revision, equipment model and location, symptom, the case brief, and the reply channel. No phone numbers, no hashes, no CRM access.
- **He returns** `{ ok: true, result: { summary?, diagnosis?, next_step?, source_id? } }`, each string at most 300 characters. Anything else is recorded as failed and nothing is sent to the caller.
- **I need from identity:** department and clearance on the safe profile. The bundle will read them the moment they exist; today it has rank, ship, language, equipment and open cases.

## Decisions API facts for the board

- `POST /v1/decisions`, model `gpt-6-luna` only. Public beta since October 6. The October 7 prep probes got model_not_found because they named other models.
- A classifier, not a writer: predicate (probability), choice (pick one, with confidence), score (ordered levels). The live model still phrases the reply.
- Input is text or user messages with inline images. No tools, files or audio.
- Input tokens are billed, output is not. Sending the whole bundle every turn is fine.
- One authorized request succeeded on October 12; see the probe below. The four Railway feature flags remain false, and this request does not authorize enabling them or making further provider requests.

## Decisions probe, October 12

At 8:44 a.m. Pacific, one Sannr `api_request` to `POST /decisions`, stack `openai`, environment `production`, model `gpt-6-luna`, returned HTTP 200 in 1,015 ms. The saved observation records **one attempt, 17 assertions passed, zero failed**. Evidence: `run-a97ad2cb-0c2c-4c50-923a-954abb0c7b16`; operation observation: `94f745f6-6e29-4cfe-92ca-4d64e8e081c4`. Raw request/response evidence remains private and ignored by Git. The assertions covered HTTP status and answer names, types and selected structural constraints; they did not certify semantic correctness or calibrate the thresholds.

The input came from `seedRoster` in a memory repository, the CRM's safe profile for Lieutenant Tavi Rourke, the existing HF-031 case brief, and `buildContextBundle`, with the exact request "the stellar survey report will not open". It contained no phone or authorization phrase. The unchanged interpreter chose **queue to access, routine urgency**. This matches the intended desk but differs from the demo's expected elevated urgency. The context does not state current duty impact or a deadline. It also already contains a pending Access task, so this returning-case result does not validate routing a new case or avoiding duplicate tasks. No worker, queue write, call or text was triggered by the probe.

Wording recommended after the probe, then approved and implemented October 12. **No further live request has tested the revised wording**:

- `needs_more_details`: "Essential information is missing that prevents choosing or starting the next action. Use facts already present in the profile and case. An exact error message or prior troubleshooting is required only when its absence prevents that action."
- `urgency`: "Rate urgency from the stated impact on current duties, deadlines, safety and mission operations. Do not infer a deadline or blocked duty from rank, department or an inaccessible report alone. If impact is not stated, choose routine."
- If the intended story requires elevated urgency, have the officer ask whether the problem blocks today's work and include the caller's answer in the context. Do not invent that answer for the current fixture.

Keep the route wording and all three numeric thresholds unchanged for now: one fixture is insufficient calibration. The complete offline suite passed **110 tests with no failures or skips** before this probe (voice 37, CRM 52, app 7, SMS 5, decisions/queue 9), on Node 26.10.0 with disposable Postgres 16. No application code or schema changed during the probe.

## Sciences rehearsal with fakes, October 12

Repeat with `node --test app/sciences.test.mjs`. The test uses the actual application wiring on loopback, a memory repository seeded from the roster, scripted fake voice-model tool calls, an injected Decisions transport, a fake Access handler and an injected SMS sender. It makes no provider requests and reads no production credentials. Local feature switches exist only inside the test fixture; no Railway settings changed.

Both timings passed: the Access result arrives after consent and call end, or before the caller gives consent. Each run loads Tavi's demo profile, confirms HF-031, builds the safe context, routes to Access with routine urgency, records explicit SMS consent, stores the fictional result, submits exactly one fake text, accepts a signed fake delivery callback, and saves the case timeline. The case remains open. Repeated reply attempts and a sweep produce no duplicate text. No text is sent before consent; the Decisions and specialist inputs contain no phone or authorization phrase.

The first run exposed two timing bugs: the worker used the pre-consent assignment snapshot, and completed results rejected later consent. The worker now uses the current task returned when it records the result. Consent is accepted for working or ready tasks; consent for an already-ready result triggers the reply through the application. Existing contact checks, caller confirmation and durable send claims remain in force. These are application fixes; no schema changed.

The full `npm test` run passed **114 tests, zero failures or skips**: voice 37, CRM 54, app 9, SMS 5, decisions/queue 9. CRM coverage includes memory and disposable loopback `postgres:16`, including consent after task completion. Node 26.10.0. Numeric thresholds remain 0.6 / 0.5 / 0.4.

Limits: the fake answers do not evaluate the revised question wording or spoken consent recognition. HF-031 already has an older pending Access task; routing creates another task and the rehearsal confirms the old one stays untouched. Task deduplication remains unimplemented. The companion still displays its separate fixtures; this rehearsal checks persisted case events, not a live screen projection. No real call, text, provider request or deployment occurred.

## Next, in order

1. Review the revised questions against additional fixtures before any separately authorized live request.
2. Plug Michael's first MCP client into `options.specialists` when he has one. Until then the worker reports `specialist_unavailable` and leaves the task working.
3. Outbound call rehearsal, flags on, only when authorized: `CALLBACK_ENABLED=true`, `TWILIO_VOICE_FROM` set, `VOICE_CALL_LIMIT` at least 2 so the callback is admitted after the first call.
4. SMS reply rehearsal depends on the same A2P 10DLC or on-screen-fallback decision as the repair text. No change there.

## Known gaps on my side

- The worker runs in-process and is triggered when a request is queued. If the app restarts between queueing and the reply, `queue.sweep()` must be called; nothing schedules it yet.
- SMS as an inbound channel is not built. The bundle and decision step accept `channel: 'sms'` so it slots in later.
- A reply over voice counts against `VOICE_CALL_LIMIT` like any call.
- The companion screen still shows fixtures; reply events are in the case timeline but not on screen. That is Michael's reporting box.
