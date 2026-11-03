# Engineering expert: SMS context requests

## Approved intent and scope

The engineering expert can ask the user for information by SMS, pause its investigation,
and resume with a text or picture reply received through Twilio. The recipient is one fixed
number supplied by the user, stored only in private configuration. Never commit that number
or credentials. Research and logistics keep their existing behavior.

This first version keeps the current ephemeral, single-replica server architecture. An
investigation retains its conversation and temporary workspace while waiting. Process
restart or redeployment ends outstanding investigations and waits. Durable checkpoints,
multi-user routing, and final-report delivery by SMS are outside this version.

## Agent and dispatch behavior

Add an internal `request_user_context` agent tool only to the engineering investigation
agent. Triage must dispatch when user clarification is needed; it must not send SMS or wait
inside the initial consultation. The tool accepts a concise question. The server chooses
the configured sender and recipient; the model cannot choose arbitrary phone numbers.

The tool reserves the single outstanding-question slot before sending and enters a
`sending` state. Only a successful Twilio create response transitions it to `waiting`.
An accepted create response means accepted for sending, not confirmed delivered. Register
the wait before the outbound request so a fast reply cannot be lost. A send failure releases
the slot and returns an actionable tool error. Do not blindly retry an ambiguous send: it
could have created a message despite a transport failure.

While awaiting the reply, the tool promise remains pending and the agent makes no further
model calls or workspace commands. Its workspace remains available. Dispatch status becomes
`waiting_for_user` with a safe status message and timestamp. Treat that state as nonterminal
for collection, cancellation and concurrency accounting. Use a distinct `sending` status
message while Twilio acceptance is unresolved.

Keep the Tasks extension wire schema unchanged: waiting collection tasks remain working,
with a human-readable waiting status. Do not invent a new MCP protocol task status.

On an accepted reply, save text and attachments under a server-controlled `request/replies/`
path and resolve the tool with the reply text and attachment paths. Resume the same agent
run and return the dispatch to working. Add image viewing to the local workspace session
so the agent can inspect attachments as actual image content through the SDK's `view_image`
capability; saving a filename or returning a URL alone is insufficient. Instructions require
the engineering agent to inspect received pictures before drawing conclusions from them.

Reject a second outstanding question with a busy result, without sending another SMS.
Completed replies release the slot. Sequential follow-ups are allowed, bounded by the
existing investigation turn budget. Match replies to the sole current wait by sender,
recipient and account. SMS has no reliable reply-to relationship: a delayed reply to a
previous question can remain ambiguous. Make this limitation explicit in operator docs.

## Twilio integration and inbound webhook

Provide a dedicated Twilio messaging client with an injectable transport for offline tests.
Use the configured Account SID plus API key SID/secret for outbound REST calls when
available, or the Account SID/Auth Token pair. Webhook validation always needs the account
Auth Token. Keep credentials in the server process; workspace subprocesses do not inherit them.

Expose `POST /webhooks/twilio/engineering-context`. This route uses Twilio signature
authentication, independent of the MCP bearer token. Validate the signature with the Twilio
SDK using the configured public HTTPS URL and all submitted form parameters. Also validate
the Account SID, sender, recipient and message identifier before accepting context.

Return empty TwiML promptly after accepting a valid inbound message. Perform authenticated
media download asynchronously, outside the webhook response. Deduplicate by MessageSid for
the process lifetime so webhook retries cannot resume a job twice. Preserve the reservation
until media preparation completes. Valid unsolicited or late replies receive empty TwiML
without reviving cancelled or expired jobs. Invalid signatures receive 403; a disabled
integration receives 503. Malformed or oversized input is rejected before costly processing.

Accept text, pictures, or both. Download only media belonging to the configured Twilio
account and the signed incoming message. Validate URL origin/path and every redirect;
never forward credentials to an untrusted redirect destination. Allow JPEG, PNG and WebP
with bounded bytes, dimensions and attachment count; detect actual image format rather
than trusting webhook MIME declarations. Unsupported media and empty messages leave the
wait active and record a safe diagnostic status. Download failures likewise leave the wait
active so the user can retry before timeout. Do not send automatic error SMS in this version.

Default limits: question at most 500 characters; webhook body at most 64 KiB; at most
3 images, each at most 5 MiB and 20 megapixels; downloads time out after 15 seconds;
user-reply timeout is 30 minutes, configurable. Store attachments only in the consultation
workspace and remove them with the normal session cleanup.

## Cancellation, expiry and lifecycle

Cancellation and shutdown abort reply waits and media downloads, release the outstanding
slot and terminate workspace processes. No subsequent reply can resolve the cancelled wait.
The reply timeout fails the investigation with a clear timeout reason, releases the slot,
and removes its workspace. Status and cancellation remain available while waiting.
Coordinate task TTL with the configured reply timeout so collection tasks do not disappear
before the supported waiting interval ends. Existing completed-dispatch retention applies
after completion, failure or cancellation.

## Configuration and deployment

Use explicit settings for enablement, Account SID, account Auth Token, optional API key SID
and secret, SMS/MMS-capable sender number, fixed recipient number, public webhook origin,
and reply timeout. Validate required settings at startup when enabled. A key alone does not
establish a usable sender or inbound configuration. Keep integration disabled by default
until configured. Preserve local-only tests without credentials or provider traffic.

Deploy to the existing Railway MCP service with one replica. Supply secrets and phone
numbers through private variables. Wiring the sender's incoming-message webhook can
replace an existing SMS handler: inspect its current configuration before proposing the
specific change, and use a dedicated sender if the current one serves another application.
Confirm any new credential transfer to Railway separately if required by approval review.

No live SMS is needed for unit/integration verification. A live smoke test requires the
configured sender, recipient and a concrete message approved by the user; check sending
eligibility first. The known imported Trial-account and A2P notes are dated claims, not
verification of this account. Agent-issued provider requests use the repository's explicit
Sannr stack; application runtime uses its normal Twilio client.

## Validation and acceptance

Use a scripted model and controlled messaging transport to verify an engineering dispatch
sends a question, exposes a waiting state, accepts text, resumes, and produces its report.
Verify picture replies reach the model as image input rather than only text paths.
Exercise invalid signatures, wrong sender/account/recipient, duplicate messages, early
replies, busy slots, ambiguous send failures, unsupported or oversized media, unsafe
redirects, download failure, timeout, cancellation and shutdown. No test reaches Twilio
or OpenAI. Keep existing MCP authentication, task lifecycle, direct-answer and other-expert
tests green, then run `npm run verify` before deployment.

## Source references

- Existing flow: `src/experts/dispatch.ts`, `src/experts/investigator.ts`,
  `src/experts/local-workspace.ts`, `src/tools/index.ts`, `src/http.ts`.
- Repository context: `../docs/api-prep/twilio/README.md`, `BUGS.md`, and the
  operation notes for `POST /2010-04-01/Accounts/{AccountSid}/Messages.json`.
- Twilio inbound fields: https://www.twilio.com/docs/messaging/guides/webhook-request
- Signature validation: https://www.twilio.com/docs/usage/webhooks/webhooks-security
- Authenticated media: https://www.twilio.com/docs/messaging/tutorials/how-to-receive-and-download-images-incoming-mms/node
