# IT/Maintenance routing and shared CRM context

This is the October 12 update to Sterling's side of the whiteboard. Michael owns identity, reporting and specialist agents/MCP servers. The reporting agent handles the initial call; IT or Maintenance owns any specialist callback. Expert remains the agent entry point, not a third routing destination.

## Implemented contract

1. `load_crew_profile` uses the existing fictional authorization phrase gate and returns `crm_context` alongside the profile. Authorization storage/verification is unchanged. No case is selected automatically.
2. After caller confirmation, `resume_case` selects an open case, or `review_case` reads a resolved/closed case without reopening it. Recent cases appear in the profile. A new issue can open a new case after reviewing a closed one.
3. `get_crm_context` refreshes the loaded profile, equipment, contact history, selected case, current queue and reusable answer. The shared object excludes contact values, authorization hashes and reply credentials. Lists and free text are bounded; formatted international phone numbers are withheld.
4. `route_request` fetches fresh CRM data. Decisions receives `crm_context.text`, which contains the complete allowlisted object as JSON plus a readable summary. GPT Live receives that same context in the tool result. The stored task gets an immutable `context_snapshot`, exposed to the specialist as `task.context`; it survives hang-up and later profile changes.
5. The route choices are `it`, `maintenance`, and `none`. A valid expert route with confidence **above 0.50** takes priority over missing details and CRM issue matching. Remaining thresholds are **0.60** for a stored answer, **0.75** for missing details without a confident route, and **0.40** for selecting an existing issue. The missing-details threshold was raised from 0.5 during the October 12 follow-up-loop review; see [the current scoring policy](decisions-api.md). `none` with sufficient resolvability can return a stored answer to the reporting agent on the call. Model confidence alone cannot create a solution: the CRM must have a current successful answer or a caller-confirmed case finding.
6. A same-case, same-symptom-revision task already working at the selected desk is reused transactionally. Reuse does not invoke `onQueued` again. Changed symptoms invalidate old results, and the case/revision and solution are rechecked after classification to reject races. Failed, obsolete or caller-rejected findings cannot be reused. A proposed answer is explicitly different from a caller-confirmed fix; newer unrelated results do not inherit confirmation.

`route_request` returns `outcome`, `route`, `urgency`, `task_id`, `callback_owner`, `reused`, `crm_context`, `solution`, and `next_action`. A solution has no new `task_id`. Caller confirmation and explicit close remain separate steps.

## Handoff to Michael

Register handlers under `options.specialists.it` and `options.specialists.maintenance`. Each receives the existing task assignment plus `context`, the safe snapshot used to route that task. Pass that argument through Expert to the appropriate agent. The adapter must consume `task.context`; rebuilding only the old equipment/brief payload discards CRM fields. Return the existing bounded `{ ok: true, result: { summary?, diagnosis?, next_step?, source_id? } }` shape. All result strings are at most 300 characters.

The model-facing context deliberately contains no dialable number. Callback consent and the destination remain server-side on the task. The specialist-owned callback integration should use the stored reply preparation/claim/outcome workflow; do not put contact credentials into the shared context. `request_reply` reports the desk as `callback_owner` for voice consent.

**Direct specialist callbacks are not wired by this change.** The existing callback transport reconnects to the reporting bridge, so `reply/call.mjs` returns `unavailable` for IT/Maintenance without claiming the task or placing a call. The result and consent remain available. Michael's agent implementation, MCP server and reporting UI are untouched by this change.

Other limits: reused working tasks are not automatically redispatched after a process restart; the worker still needs durable recovery. Solutions are scoped to the caller-confirmed case and symptom revision, not a global search across other callers' issues. A caller-rejected finding remains excluded until the case is updated or the caller changes its recorded outcome. The existing identity gate is a fictional demo profile loader, not production identity verification.

## Migration and verification

Migration `004_it_context.sql` adds `context_snapshot` and renames stored Access tasks to IT while preserving their IDs, results and consent. Historical route values remain accepted for old authored workflows; the new Decisions question never emits them. The roster now seeds Tavi's pending task as IT. No new top-level folder was added and the scenario seed's loopback guard was not edited.

Offline checks cover both desks, identity gating, identical shared context at the three boundaries, concurrent task deduplication, stale/rejected answers, solved closed cases, specialist callback ownership, and the Sciences SMS rehearsal with both consent timings. Database contracts run against disposable loopback `postgres:16`, including upgrading an existing Access task and preserving its reply consent.

The full working-tree `npm test` run passed **144 tests, zero failures or skips**: voice 37, CRM 61, app 9, SMS 5, decisions/queue/specialists 32. The specialist-adapter tests include concurrent work outside this commit. These are fake/local checks, not deployed provider verification.

The original Sannr Decisions probe is recorded in `whiteboard-2026-10-12.md`: HTTP 200, one attempt, 17 structural assertions, old Access/routine classification. Neither the revised wording nor this new IT/Maintenance/shared-context request has been tested live. No live requests, Railway changes, feature-flag changes, deployments or pushes were made for this task.
