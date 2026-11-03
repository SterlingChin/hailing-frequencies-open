# Real CRM and Decisions rehearsal

The local page at `http://127.0.0.1:4174/rehearsal.html?mode=real` is an operator console for fictional Avery Chen. It uses the main Railway app's `POST /api/reporting` and `POST /api/decisions` endpoints through a loopback server. The browser receives safe CRM context, the four Decisions answers, queue status and a timeline; it never receives `REPORTING_API_TOKEN` or the signed CRM session token.

The server starts a fresh CRM interaction and loads Avery using the fictional demo phrase. This is a rehearsal shortcut, not identity verification. Select an existing case with explicit confirmation, or open a new case from Avery's returned equipment list. “Ask the four Decisions questions” sends the selected case's current CRM context plus the entered caller request to Decisions. Repeat an IT or Maintenance request to see whether the queue reuses the current task. A stored solution can be offered only when CRM has a current, successful finding; the caller's confirmation remains separate.

The page shows each Decisions answer, the selected outcome, the current task, and a suggested reply. It does not place a call or send that reply. No Twilio number, outbound callback or SMS is used. The specialist worker can run only if the main Railway app has a configured specialist handler. A queued task alone is not a completed finding.

## Local setup

Set `REPORTING_API_TOKEN` to the same private 32–256 character value on the main Railway app and the local reporting server. Keep it out of Git and browser environment variables. Set `HF_BACKEND_URL` to the main app's HTTPS origin, `REHEARSAL_ENABLED=true`, `HOST=127.0.0.1`, and `PORT=5173`. No GPT Live key is needed for this page. The rehearsal API refuses non-loopback listeners.

From `reporting-ui/`, install dependencies and run `npm run dev` to start the local server. Run `npm run build:rehearsal` and `npm run preview:rehearsal` for the requested port 4174; preview proxies `/api` to the loopback server on 5173. Open the link above. The `?mode=fixture` page remains an offline walkthrough.

## Three paths

1. **Stored solution:** Select an Avery case with a current stored solution, ask Decisions, read the returned answer, and record `confirmed_fixed` or `not_fixed` only if the caller actually says so. If no case has a current solution, this path cannot pass yet; first obtain a real specialist result through the queue.
2. **IT:** Open or select a control-panel access case and ask for IT. The first request creates a task; repeating the same request while it is pending should reuse that task ID.
3. **Maintenance:** Open a new replicator interruption case and ask for Maintenance. A new task should appear with the case context. The worker's result is a separate later event.

The page displays actual API outcomes and errors. Changing the scenario selector only changes the suggested caller request. It never seeds cases, fabricates specialist findings or rewrites queue state.
