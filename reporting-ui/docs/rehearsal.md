# Reporting flow rehearsal

This page is a local, fake-data rehearsal of the agreed intake and callback
flow. It demonstrates the intended experience, not a working integration.
All people, cases, history, decisions, queue entries, results and call events
are invented. Each event advances only when the operator uses its control;
there are no timers, agent calls or background callbacks.

## Run and rehearse

From `reporting-ui/`, use `npm run dev:rehearsal` and open
`http://127.0.0.1:5174/rehearsal.html`. Vite serves only the frontend and
shared design CSS. The rehearsal configuration disables `.env` loading and
does not import the API, Live client or agent implementations. It uses no
microphone, network API, browser storage, real contact destination or credential.
Reloading, resetting or switching stories discards all rehearsal state.

1. Choose a story and start intake. The reporting agent owns the initial call.
2. Enter the displayed fixture code, `DEMO-484`. An incorrect code keeps the
   CRM panel locked. A correct code confirms the demo identity; loading CRM
   context is a separate event. This is a presentation gate, not authentication:
   the invented fixtures are part of the browser bundle.
3. Make CRM context available. The same fictional profile, issue, history,
   queued work and solution source are available to the reporting agent and
   decision step. The decision is predetermined by the selected story.
4. Rehearse the decision:
   - **Existing solution:** the reporting agent offers the prior repair on
     the initial call. Caller confirmation completes the case without a task
     or callback. “Still not working” queues Maintenance with the current
     context and the unsuccessful outcome.
   - **IT:** reuse an existing queued task for the report-access issue.
   - **Maintenance:** queue a new task for the interrupted replicator orders.
5. Start specialist work, then simulate an explicit caller callback request.
   The initial call ends; the assigned specialist owns the callback. Alternatively,
   end without consent: a result may arrive, but a call cannot be placed.
6. Record the specialist finding, then place a simulated callback. “No answer”
   keeps the case open; a retry requires another explicit caller request.
7. When the caller answers, confirm demo identity again before the specialist
   speaks the finding. Only the separate “Caller confirms it worked” event
   completes the case and callback.

## State meanings

These are UI-local rehearsal states, not new API fields or shared enums.

| Display | What the fixture establishes | What it does not establish |
| --- | --- | --- |
| Queued | One task is assigned or reused | Work has started |
| Specialist working | IT or Maintenance has the context and is investigating | A finding or callback exists |
| Callback requested | The caller explicitly requested contact by the assigned specialist | A call has been placed |
| Result ready | A specialist finding is recorded after intake ends | The caller received it or the issue is resolved |
| Call placed | A simulated attempt exists | Answer, callback identity or resolution |
| Call placed · no answer | The attempt did not reach the caller | Callback completion or case completion |
| Call answered | A connection is simulated; callback identity is checked separately | Resolution |
| Completed · caller confirmed | The fixture records explicit caller confirmation | Any actual provider or CRM outcome |

Task state, callback state, callback attempts and case resolution are separate.
Duplicate and out-of-order actions cannot skip their required events. The
communications-desk timeline retains the full simulated sequence, without
automatic scrolling, even after intake ends or a call is unanswered.

## Ownership and integration boundary

The new page uses the repository's existing design tokens and components,
with a bridge layout on desktop and large communicator captions on mobile.
It defines no shared event or API contract. Michael's agent code, the original
Live page/client/server, routing, CRM, queue and migrations are untouched.
Coordinate with Michael before mapping this presentation to shared events or
changing those contracts. The fixture callback owner expresses the agreed
experience; it is not evidence that production specialists can place calls.

## Verification — October 12, 2026

`npm test` passes **28 offline tests**, including nine rehearsal state tests.
They cover identity gating, distinct context availability, reuse of a solved
issue, rejection of an unsuccessful solution, both specialist owners, explicit
consent, no-answer/retry, duplicate and out-of-order events, and reset isolation.
The existing communicator build and the separate rehearsal build both pass.

The optional browser check requires an installed Playwright with Chromium.
Build and serve the rehearsal first:

```sh
npm run build:rehearsal
npm run preview:rehearsal
```

In another terminal, run `npm run test:rehearsal:browser`. If Playwright is
provided by a local tooling runtime, set `PLAYWRIGHT_MODULE` to its absolute
`playwright/index.mjs` path. This does not add a runtime dependency to the app.
The check permits only local static GET requests, blocks browser API and media
transports, and fails on unexpected requests or console errors. It exercises
every story, the unanswered and declined-callback paths, keyboard focus, reset
and reload. It captures screenshots under ignored `test-results/`.

Chromium checks passed at 1440×900, 390×844 and 720×450 with no horizontal
overflow, console errors or API/provider requests. Desktop and mobile screenshots
were visually reviewed. These checks do not verify a physical iPhone or Safari.

Still unverified: real identity, CRM authorization and subscriptions, model
routing, queue execution, durable storage, specialist callback ownership in
the backend, callback consent enforcement in a live service, telephone answer
or delivery evidence, and live resolution events. No live requests, Railway
changes, deployments or pushes were made for this rehearsal.
