# Twilio examples — opt-in live requests

These are small single-request examples, reviewed offline and not executed for this package. They require your own production credentials and explicit task authorization. Responses can contain private account/resource data; keep output and evidence local.

| File | Stack / environment | Expected result | Cleanup |
| --- | --- | --- | --- |
| `accounts-read.json` | `twilio` / `production` | 200 and an `accounts` array; requests at most one page item | No resource created |
| `verify-services-read.json` | `verify` / `default` | 200 and a `services` array; requests at most one page item | No resource created |

Ask the agent to run the chosen envelope through the loaded repository-bound Sannr tool with the named stack and environment. If the tool is not loaded, follow the installed skill's fallback. An authorized CLI invocation is:

```sh
./node_modules/.bin/sannr protocol docs/api-prep/twilio/examples/accounts-read.json --stack twilio --env production
./node_modules/.bin/sannr protocol docs/api-prep/twilio/examples/verify-services-read.json --stack verify --env default
```

Choose one command; this is not a batch script. No POST, message, call, purchase or paid Lookup example is included. A 401/403 can reflect account capability as well as credentials; read the actual error before retrying.
