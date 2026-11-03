# OpenAI examples — opt-in live requests

These are reviewed single-request examples, not a bulk benchmark or a run completed for this export. Read the request before authorizing it. Supply your own API key, project access and generation budget. Model names reflect the preparation snapshot; availability is account-specific.

| File | Action | What its assertions establish | Cleanup |
| --- | --- | --- | --- |
| `models-read.json` | Metadata GET | 200 and a model-list array; does not prove generation access | No created resource |
| `responses-small.json` | Paid generation, at most 16 output tokens requested, `store: false` | HTTP/status/output-token checks only; also inspect that a message actually contains text | No stored response requested; provider retention policies still apply |
| `chat-structured-small.json` | Paid generation, at most 20 output tokens requested, `store: false` | HTTP, content type and finish checks; parse content and validate the JSON schema separately | No stored completion requested; provider retention policies still apply |

Prefer the repository-bound Sannr tool with stack `openai`, environment `production`. Writes remain refused unless the human has authorized the specific request and its cost. Do not persist a global write-enabling setting in the package. For an authorized CLI fallback on macOS/Linux, scope the switch to that one process:

```sh
./node_modules/.bin/sannr protocol docs/api-prep/openai/examples/models-read.json --stack openai --env production
API_ALLOW_PRODUCTION_WRITES=1 ./node_modules/.bin/sannr protocol docs/api-prep/openai/examples/responses-small.json --stack openai --env production
```

These are alternatives to select individually, not commands to paste and run together. To test structured output, select `chat-structured-small.json` instead after authorizing it. No live command is part of setup. PowerShell users can ask their agent to apply the same process-scoped setting without changing a shared registration.

Small output caps are not dollar caps. For a 429 inspect quota versus throttling. For incomplete output or a refusal, handle it honestly rather than repeatedly retrying or raising limits without a budget decision. Do not merge stderr warnings into JSON stdout.
