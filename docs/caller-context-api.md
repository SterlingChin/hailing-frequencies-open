# Caller context API for Michael's service

This is a server-to-server API for the fictional crew demo. It loads CRM context **after** the caller gives their name and existing authorization phrase. A phone number is only a lookup hint. The phrase loads a demo record; it does not prove a real person's identity, ownership of the phone, or liveness.

Base URL: `<your deployment URL>`, the HTTPS origin where the app is deployed. These routes are available only when the app has a `CONTEXT_API_TOKEN` of at least 32 characters. Keep that token in Michael's server environment, not a browser, prompt, transcript or repository. Send it as `Authorization: Bearer <token>` on every request over HTTPS. All requests are JSON `POST`; responses have `Cache-Control: no-store`. The service does not enable cross-origin browser access.

## Call flow

1. `POST /api/v1/caller-context/start` with `{"caller_phone":"<caller number in E.164>"}`. `caller_phone` may be omitted for a withheld number. It is a hint, not a credential. A `201` response contains `session_token`, `expires_at`, and `state: "authorization_required"`. It contains no candidate count, name or case data.
2. Ask the caller for their **name and fictional authorization phrase**. `POST /api/v1/caller-context/authorize` with `{"session_token":"...","name":"Avery Chen","authorization":"Alpha seven, Bravo nine, Echo two"}`. Both fields are required and must match the same CRM record; names ignore letter case and extra spaces. On `200`, the response has `state: "demo_profile_loaded"`, `assurance: "fictional_phrase_only"`, `crew_member_id`, and `profile`. A wrong name or phrase returns `401 phrase_not_accepted`; the fourth attempt on a session returns `429 attempt_limit`. Do not reveal whether the name or phrase matched. A phrase match identifies a demo row; Decisions checks whether the assigned ship is recognized before accepting a report.
3. `POST /api/v1/caller-context/context` with `{"session_token":"..."}` to refresh the same safe profile and authorized `crew_member_id`. Before authorization it returns `403 authorization_required`.
4. `POST /api/v1/caller-context/end` with `{"session_token":"..."}` when the call ends. This closes the CRM interaction and invalidates the token. The token expires after 15 minutes and fails closed on restart; start a new session and ask for the name and phrase again when that happens.

The top-level `crew_member_id` is the UUID from `crew_members.id`, not a session or interaction ID. It is returned only after successful authorization and remains the same on `/context` refreshes. Michael can pass it unchanged to [Decisions](decisions-api.md) with the reporter conversation: `{"crew_member_id":"<returned UUID>","context":"<conversation text>"}`. Decisions uses `REPORTING_API_TOKEN`, while this identity API uses `CONTEXT_API_TOKEN`.

The `profile` is the CRM's existing safe view: name, rank, ship, department, section, clearance, posting, legacy `language`, `preferred_language`, status, derived prior-contact count and last contact, equipment, preferences, and open case briefs. `preferred_language` is either `english` or `klingon`; use it for spoken replies after the profile loads. It excludes phone numbers, contact records and authorization hashes. A case must still be confirmed by the caller before resuming it. Do not say a case is selected merely because it appears in `open_cases`.

The server caps active sessions and phrase attempts. A stolen service token could still create sessions, so keep it private and rotate it if exposed. This API accepts caller phone data from Michael's service; it does not independently validate a Twilio webhook. Michael should validate his own inbound-call source before using the phone hint.

## Example

```http
POST /api/v1/caller-context/start HTTP/1.1
Authorization: Bearer <private-service-token>
Content-Type: application/json

{"caller_phone":"<caller number in E.164>"}
```

```json
{"session_token":"<opaque-token>","expires_at":"<UTC-time>","state":"authorization_required"}
```

Authorize the session:

```json
{
  "session_token": "<opaque-token>",
  "name": "Avery Chen",
  "authorization": "Alpha seven, Bravo nine, Echo two"
}
```

After a successful `authorize`, use only facts in the returned `profile` when speaking about the caller. `open_cases` includes a bounded `brief` for each open case. For an unfamiliar or withheld number, the correct name and phrase can still load their matching demo profile.

For Commander Avery Chen's fictional profile, send `name: "Avery Chen"` and `authorization: "Alpha seven, Bravo nine, Echo two"` as separate fields. Do not include the name in the spoken phrase. The database stores its hash in `crew_members.auth_code_hash`, never plaintext. The older Avery phrase no longer matches after the updated demo seed is applied.

For the nonexistent-ship demo, send `name: "Bethany Ann"` and `authorization: "Ann, Bethany, seven two alpha"`. A correct phrase returns her demo `crew_member_id`. Send that ID and the conversation to [Decisions](decisions-api.md); it responds `404 crew_member_not_found` with `reason: "ship_not_found"` because USS Nebraska does not exist in the demo. No reporter context or task is saved. Call `/end` when finished.

The authorization request uses `name` and `authorization` in place of `spoken_phrase`; the old request field is rejected. Deploy the matching endpoint change before switching Michael's client. Existing name-prefixed demo hashes remain supported server-side, so splitting the request fields does not require another data reset.

## Deployment handoff

Set a fresh random `CONTEXT_API_TOKEN` on the Railway app service, then deploy the commit containing this API. Keep voice, SMS, Decisions and callbacks at their separately approved settings. The API does not call Twilio or OpenAI. Run a private end-to-end check with a fictional roster entry, then give Michael the base URL, this document, and the token through a secure channel. Do not paste the token into chat or an issue.
