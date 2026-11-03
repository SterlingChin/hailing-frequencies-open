# Known limitations — Sannr 0.1.0-alpha.10

Summarized from October 7–9 preparation reports. These are version-scoped findings, not claims that every route or later release has the same problem. Setup and package tests do not execute provider APIs.

| Finding | Practical guidance |
| --- | --- |
| `map`, `audit`, `check`, `learn` and plain `doctor` can send requests. A multi-stack map also produced misleading host results in the preparation. | None is a required setup step. Use the supplied offline tests and read saved notes. |
| Some request commands emit route warnings on stderr alongside JSON stdout. | Keep streams separate; do not pipe merged output into a JSON parser. |
| Captured values are not interpolated in `expect`. | A comparison against `{resourceId}` may compare the literal text. Check presence/type, then explicitly verify the captured value separately. |
| A failing step can prevent later cleanup in a request chain. | Track created resources as you go and perform deliberate cleanup; do not assume the final DELETE ran. |
| Double braces in bodies can be interpreted as unresolved placeholders. | Eval/grader templates may be blocked. Substituting a literal string changes the test; do not call that equivalent. |
| Multipart parts lack explicit per-part MIME types and retain only a basename. | Image edits and directory-based skills uploads encountered failures. Confirm client support before choosing them. Do not bypass a request refusal. |
| Protocol JSON input is capped at 1 MiB. | Large inline image data can be rejected locally; use smaller valid input or a supported uploaded-file route. |
| Complex regex assertions may appear as mismatches when the guard rejects the regex. | Prefer simple assertions and explicit JSON parsing/schema validation in your app. |
| `note --env` is not supported by this alpha's legacy note command; supersession/evidence behavior had unresolved reports. | Use the installed skill's supported syntax, include scope/date in prose, and read the note back. Never invent a successful evidence link. |
| Inventory/feedback “verified” counters do not summarize every captured assertion result. | Read the actual scoped receipt; an authored note and an observation are different from a passed assertion. |
| Batch captures can echo identifiers; minted secrets are returned in raw evidence. | Keep command output and `.sannr/evidence` private. Share redacted lessons, not logs. |
| An onboarding receipt may be absent. | Say it is absent. Do not make calls just to create a setup receipt. |

The earlier alpha.9 Basic-auth and OpenAI prefix-capture issues have alpha.10 regression evidence. They are historical, not current blockers in this package. Your coding host still needs its own setup/activation check. See [package history](../HISTORY.md).

## Limitations attached to API operations

These findings are also saved as version-scoped authored notes on the affected operations in `.sannr/stacks/`. Retrieve them with Sannr before planning a request. They describe client limitations, not provider defects. The [operation mapping](docs/CLIENT-LIMITATIONS.json) records the exact notes and readback checks.

| Finding | Attached operations |
| --- | --- |
| CLI-006 | `openai: POST /images/edits` |
| CLI-008 | `openai: POST /skills` |
| CLI-005 | `openai: POST /evals`, `openai: POST /fine_tuning/alpha/graders/validate` |
| CLI-007 | `openai: POST /responses`, `openai: POST /chat/completions` |
| CLI-003 | `openai: POST /chat/completions` |
| CLI-004 | `openai: GET /files/{file_id}`, `openai: GET /conversations/{conversation_id}`, `openai: GET /vector_stores/{vector_store_id}`, `openai: GET /batches/{batch_id}`, `openai: GET /containers/{container_id}`, `openai: GET /responses/{response_id}`, `openai: GET /evals/{eval_id}` |
| CLI-009 | `openai: POST /batches`, `openai: POST /uploads` |
| CLI-010 | `openai: POST /live/sessions` |
| QUOTA-429 | `openai: POST /responses`, `openai: POST /chat/completions`, `openai: POST /embeddings` |

QUOTA-429 is this export’s label for the October 7 quota-versus-throttling report; the original report did not assign it a CLI number. Historical billing errors must be classified from their provider type/code.
