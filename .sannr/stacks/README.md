# Project API inventory

Updated October 12, 2026 from the application source, the caller-context release,
and existing Sannr observations. Contract inventory is not live verification.
Select a stack explicitly. Every configured target is production, including the
`app/reporting` credential profile and environments called `default`.

| Stack / environment | Contract coverage | Credential and availability |
| --- | --- | --- |
| `app` / `production` | Health; four caller-context operations; reporting and Decisions; incoming/outgoing voice webhooks; SMS callback; fixture SSE; media WebSocket upgrade. 12 operations. | `CONTEXT_API_TOKEN` for caller-context. Public health needs no credential. Voice/SMS callbacks use Twilio signatures, not this bearer token. |
| `app` / `reporting` | Same service and contract; separate credential profile for `/api/reporting` and `/api/decisions`. | `REPORTING_API_TOKEN`. These two endpoints are local source, not included in the caller-context release. Decisions also requires the opt-in `app/context-server.mjs` entry point. |
| `reporting-ui` / `production` | Health, browser session, SSE, Live start/stop/ready, report editing/selection. 8 operations. | Browser cookie, CSRF token, and matching Origin for mutations. Source inventory; no new Live traffic was used to verify it. |
| `specialists` / `production` | `/healthz` and stateless MCP `/mcp`. 2 HTTP operations. | `SPECIALISTS_MCP_TOKEN` names the caller's bearer credential; the server calls it `EXPERT_MCP_TOKEN`. MCP tool calls may use OpenAI and require separate authorization. |
| `openai` / `production` | Existing OpenAI provider contract, including `/decisions` and Live. | `OPENAI_API_KEY`; existing historical notes and observations retained. No provider contract change in this update. |
| `twilio`, `messaging`, `lookups`, `verify` | Existing Twilio provider contracts. | Existing per-stack credentials and historical notes retained. App-owned webhooks belong to `app`, not these provider contracts. |
| `unsorted` | Seven inherited unbound operations. | No environment; not executable. |

The current caller-context request is:

```json
{
  "session_token": "<session from caller-context/start>",
  "name": "Avery Chen",
  "authorization": "Alpha seven, Bravo nine, Echo two"
}
```

`spoken_phrase` is no longer accepted there. The separate reporting adapter
still uses `load_crew_profile` with `arguments.spoken_code`; its signed one-hour
session is not interchangeable with caller-context's opaque, 15-minute session.
The reporting UI also has its own demo identity fixture. Updating CRM authorization
does not change Michael's UI or agent identity logic.

Shared CRM context includes the safe profile, selected case, current queue and
eligible stored solution. `/api/decisions` can return a stored answer or queue/reuse
IT or Maintenance work. Queue persistence, expert dispatch and callback completion
are separate facts. The current specialist adapter still lacks an `it` mapping
and does not forward the full saved shared context; this inventory does not claim
those implementation gaps are fixed.

## Deployment evidence and limits

The name/authorization release was merged in PR #3 at `de4e111` and Railway
deployment `0232eac5-0270-4fd0-9aea-5307b54d8c0f` reached SUCCESS on October 12.
Its migration command applied zero new migrations. Sannr health evidence
`run-916bfaf5-50f7-4ae1-8155-da93fedf4bcc` passed eight assertions: HTTP 200,
application/database ready, fixture companion, and all four voice/SMS/Decisions/
callback flags false. This is application readiness, not provider verification.

The subsequent Avery session test was refused locally with
`PRODUCTION_WRITE_REFUSED`, zero network attempts and no session created. Both
local registration files contained `API_ALLOW_PRODUCTION_WRITES=1`, but the running
MCP process did not honor it. Their binding hashes also predated the launch-setting
changes; the hashes were regenerated from those settings with Sannr's own binding
function, preserving disabled retries and redirects. Reload the repository-bound
client and check the newly generated marker in AGENTS.md before the
already-authorized test; do not mark the environment non-production or switch
clients to bypass the refusal. A matching setup binding confirms the repository
identity, not that changed launch settings have reached the running process.

## Refresh without traffic

Edit the applicable OpenAPI contract, then use `sannr init --stack <name>` to
inventory it. `init` preserves existing notes and scoped observations; it does
not promote source declarations to executed behavior. `sannr learn` makes requests
and must not be used as a static refresh. Read operation scope/history with
`sannr show '<METHOD /path>' --stack <name> --human`; an old observation under a
different contract digest remains historical evidence, not a fresh assertion.

The app and specialist credential configurations reference the local `.env` by
path and variable name only. Never commit the values, browser/session credentials,
raw response evidence, or local feedback. No OpenAI/Twilio request is authorized
by adding an operation to this inventory.
