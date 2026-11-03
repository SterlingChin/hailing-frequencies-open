# CRM context and Decisions backend

The reporting agent also owns routing. Our Decisions backend assembles the authorized CRM context, classifies the issue, and returns a recommended action. **It never calls the Expert MCP server.** The reporting backend executes the returned handoff and owns its dispatch tracking. Michael's agent and UI code are unchanged.

This October 12 boundary is implemented in PR #10: Decisions prepares the handoff, and the reporting backend owns MCP discovery, execution and collection.

## Reporter request

Michael's reporting backend authenticates the caller and sends their CRM `crew_member_id` plus the conversation as a plain text `context` blob. Our Decisions API trusts that caller identity; there is no phrase check or caller-session requirement on this path. The backend service token still identifies the reporting service.

```http
POST /api/decisions
Authorization: Bearer <REPORTING_API_TOKEN>
Content-Type: application/json
```

```json
{
  "crew_member_id": "<CRM crew member UUID>",
  "context": "Reporter: What happened?\nCaller: The stellar survey report will not open."
}
```

These are the only two fields. `context` accepts 1–64,000 JavaScript string characters of nonblank, well-formed text, including formatting and line breaks; NUL is rejected. The JSON body limit is 512,000 bytes. Unknown crew IDs return 404 before storage or classification. The fictional Bethany Ann row also returns `404` with `{"ok":false,"error":{"code":"crew_member_not_found","reason":"ship_not_found","message":"USS Nebraska does not exist in this demo."}}`: her phrase can identify the demo row, but her assigned ship does not exist, so no reporter context, Decisions model call, case or task is created. The legacy session request has the same result. Caller identity overrides embedded inside the blob are just text, not authority.

Each accepted submission is appended verbatim to the private CRM `reporter_contexts` table with its own ID, crew ownership, timestamp and eventual case association. `context_id` is the receipt returned to Michael. Storage happens **before** classification, including when Decisions is disabled, refuses, times out or fails. Each POST is a new submission; there is no automatic retry or promise of request-level idempotency. A follow-up POST adds context without overwriting earlier conversation. This does not record audio or automatically transcribe calls.

The backend loads the complete caller-owned profile, equipment, cases, task history/current queue, stored findings, part and message history, case events, interaction history and saved reporter blobs. This version 2 context does not use the older five-case/ten-task preview limits. Stored authentication hashes, contact records and transport credentials stay private; phone-like numbers are withheld from the projected text, while the original blob stays intact in CRM. The reporter is responsible for the content it supplies; free text is not a credential vault or proof that a requested action is authorized.

The classifier receives that assembled context and the declared tool catalog in one request. Alongside the four routing questions it answers an `issue` choice: an owned case, `new:<equipment UUID>`, `new:unassigned`, or `unclear`. The issue question matches CRM records; it does not approve access or control routing by itself.

A valid IT or Maintenance choice with confidence **strictly greater than 0.50 routes to the expert**, even when `needs_more_details` is high or the issue match is unclear. Exactly 0.50 does not pass. Without a confident expert route, the missing-details threshold remains 0.75 and the stored-answer threshold remains 0.60. Provider errors, malformed answers and refusals still do not route.

Issue confidence below 0.40 or `issue: unclear` cannot select or modify an existing case or reuse its solution. If the desk is confident, the backend instead creates a caller-owned general support case with `equipment_id: null` and returns `reason: route_it_without_case_match` (or the Maintenance equivalent). Explicit `new:unassigned` also creates a general case. No unrelated equipment record is attached or invented. The raw `issue` and `answers.issue` remain unchanged; `context.selected_case.id` identifies the case actually used. Repeated identical full-text submissions reuse a single matching open general case and its pending task; different text is not guessed to be the same issue. A new case stores a bounded symptom preview while the full blob remains in CRM and handoff context.

For example, both reported Avery personal-log score sets (IT 0.96/details 0.80/unclear 0.42 and IT 0.97/details 0.48/unclear 0.64) now produce an IT handoff in the fake regression. The reporter can return an access approval after IT records that result; routing confidence is not proof access was granted. Existing case ownership, revisions, stored-solution eligibility and in-flight context checks remain enforced.

For operational bounds, an assembled context above 190,000 serialized characters or more than 255 issue choices returns `undecided / context_capacity_exceeded` without a provider request. All submitted data stays saved and is returned; nothing is silently trimmed to fit. This requires a future explicit compaction/retrieval policy if a caller accumulates more history than one request can carry.

### Existing reporting sessions

The earlier `{session_token, request}` request remains supported for Michael's existing integration. It still uses the one-hour `/api/reporting` session, phrase-loaded profile and caller-selected case, and keeps the 300-character request limit. Do not mix the two request shapes. Its returned context remains version 1. The separate [caller-context API](caller-context-api.md) still accepts `name` and `authorization`; no identity or agent code was changed here.

## Three reporting-agent actions

Successful decisions return `action.type`:

| Action | Reporting agent's next move |
| --- | --- |
| `respond` | Explain `action.solution` using `context`. Say it is fixed only when `confirmed_fixed` is true. Otherwise share the stored specialist finding and ask whether it helped. No new expert dispatch. |
| `gather_context` | Ask one focused, unanswered question essential to routing using all prior `context`; do not repeat answers or continue expert troubleshooting. Then call Decisions again with the same `crew_member_id` and fuller conversation text as `context`. The API saves the new blob. Legacy session callers still save changed symptoms with `update_symptom` first. No automatic reclassification. |
| `route_to_expert` | Confirm the proposed tool is available, claim/reconcile the task in the reporting backend, then make `action.tool_call` with its supplied `context` argument. |

Disabled Decisions, a refusal, malformed answers, insufficient routing confidence, changed context or an unusable stored answer return `outcome: undecided` and `action: null`. These are failures to decide, not an instruction to invent a follow-up question or an expert call. Explain the unavailable/review state without another troubleshooting question or an automatic resubmission of the same conversation.

`reason: decisions_unavailable` with null scores means the client was disabled before classification, not that it scored the report as incomplete. Both entry points withhold the provider key unless `DECISIONS_ENABLED=true`; normal startup additionally requires a nonblank `OPENAI_API_KEY` when that flag is enabled. A missing key with the flag enabled fails configuration validation. The supplied October 12 call response has this unavailable shape, so it cannot establish which scores the model would have returned. Check the actual receiving deployment's flag/configuration before a separately authorized live rehearsal. This change does not enable production traffic or alter any feature flag.

The response retains `outcome` (`solution`, `needs_more_details`, `queue`, `undecided`), the base routing `answers`, `reason`, `route`, `urgency`, `state`, `task_id`, `reused`, `callback_owner`, `callback_status`, `solution`, and readable `next_action`. `context_id` identifies the saved reporter blob (`null` for the older session request), and `issue` identifies the selected case/new-equipment choice. `answers.issue` carries its confidence. `context` is the shared CRM object; `crm_context` remains an identical compatibility alias. Stored tokens, session credentials, contact records and authorization hashes are excluded from the CRM projection. Reporter-provided free text remains caller-supplied data.

A route action has this shape (illustrative values):

```json
{
  "type": "route_to_expert",
  "desk": "it",
  "task_id": "<saved CRM task UUID>",
  "dispatch_key": "<same task UUID>",
  "dispatch_policy": "claim_before_dispatch",
  "tool_call": {
    "name": "expert_engineering",
    "arguments": {
      "question": "it: routine: Review reporter context <context UUID> for this issue.",
      "context": "<JSON string of the saved safe CRM snapshot>"
    }
  }
}
```

MCP's `context` argument is a **string**, serialized from the safe CRM object. It includes the profile, cases, queue, stored solutions and reporter text used to classify the assignment, plus the resulting case association. Decisions receives the gathered context and declared tool catalog before that association is saved. Caller text and stored findings are data, not additional authority.

For a new handoff, `context` is the classification snapshot from before the task was inserted. A later decision includes the saved queue entry; legacy session callers can also refresh `get_crm_context`. A repeat classification reuses a pending task for the same case, revision and desk. Its action keeps the original assignment and snapshot, while the top-level `context` reflects the latest classification. `dispatch_policy: reconcile_existing` means inspect the reporting backend's dispatch record; it does **not** authorize an automatic repeat call.

`dispatch_key` is a correlation/deduplication key for the reporting backend, not a claim made by Decisions or a guarantee that MCP accepts idempotency keys. The reporting backend must durably claim it before sending and retain any returned dispatch ID. If an acknowledgement is lost, reconcile instead of resending. Later blobs are available in the top-level context; an existing handoff keeps its original snapshot so new context is not silently treated as already delivered to an expert. The existing CRM status `working`, API `state: queued`, and legacy event kind `task_started` indicate a saved task, not proof an expert started. New routing event text explicitly says the handoff is awaiting dispatch.

## Declared MCP capabilities

`tool_catalog` is sourced from `expert-agents-mcp/src/experts/registry.ts` and `src/tools/index.ts`. `live_verified: false` means repository declarations, not a live discovery result. Decisions sends no `tools/list` or `tools/call` requests.

| MCP tool | Role in this flow |
| --- | --- |
| `expert_engineering` | Currently serves both `it` and `maintenance`; the question identifies the desk. There is no dedicated Maintenance tool in the declared catalog. |
| `expert_research` | Declared research capability; not a Decisions routing destination. |
| `expert_logistics` | Declared planning capability; not a Decisions routing destination. |
| `expert_collect`, `expert_status`, `expert_cancel`, `list_experts` | Reporting-side lifecycle/discovery tools. No call is made by Decisions. |

The reporting backend must reconcile this catalog with the MCP tools actually available to its connection before execution. `ANSWERED.answer` is a finished MCP answer; `EXPERT_AGENT_DISPATCHED` supplies a dispatch ID, not a completed answer. Collect it until `completed.report`; a triage summary is not a repair result. Persist a bounded completed finding against the original task/revision so later Decisions calls can reuse it. A changed symptom invalidates older results; a caller-rejected finding is not a solved issue.

## Callback ownership and remaining integration

IT/Maintenance own callbacks. The reporting agent handles the initial conversation. `callback_status` reports only saved facts: `not_requested`, `callback_requested`, `placement_unknown`, `call_placed`, `failed`, `unavailable`, or null without a task. Consent, expert completion and call placement are separate facts; none establishes callback completion.

Michael's remaining integration is to consume `action`, durably track MCP dispatch/collection and save specialist results, and connect specialist-owned callback consent/contact binding and delivery events. These integrations have been rehearsed with fakes, not implemented in his agent code here. The shared model context intentionally contains no callback destination; contact binding stays in trusted backend state.

## Runtime and verification

Both `npm start` (`app/server.mjs`) and the compatibility entry point `app/context-server.mjs` mount `/api/decisions`, using one CRM service. Configure migrated `DATABASE_URL` and backend-only `REPORTING_API_TOKEN` (32–256 non-whitespace ASCII characters). `DECISIONS_ENABLED=false` makes no provider request. When enabled, an authorized classification can make one billable OpenAI `POST /v1/decisions` request using the existing server key, with no retry or redirect. Construction/startup sends no provider request.

Apply migrations through `007_general_support_cases.sql` before deploying this intake; it permits a null equipment link while retaining ownership constraints for every non-null link. There is no automatic retention/deletion job for saved blobs yet.

HTTP 200 means the attempt was handled; inspect the action and outcome. Before classification, errors use `{"ok":false,"error":{"code":"..."}}`: 400 invalid JSON/arguments, 401 service/session authentication, 403 identity required/browser Origin, 409 ended interaction, 413 oversized body, 415 non-JSON, 503 unavailable service. An unknown crew ID or missing service token means 404. Reporting sessions expire after one hour.

Local tests cover both entry points, trusted crew identity intake and backend authentication, full-blob persistence/reload, the three actions, duplicate handoffs, immutable snapshots, stale/rejected solutions, failures and private-data filtering. A fake reporting actor explicitly calls a fake expert after gathering context, saves the result, and receives a reusable answer. The Sciences voice rehearsal separately checks consent and fake SMS status handling. The backend dispatch hooks and expert handlers remain untouched during decision requests, even when injected. Postgres tests use a disposable loopback database.

No live request, deployment or Railway flag change is part of this revision. Keep all four production flags false until separately authorized. Passing fakes does not verify the deployed provider or current MCP tool availability.
