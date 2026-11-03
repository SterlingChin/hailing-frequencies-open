# Going public: owner's checklist

Use this before the repository's visibility changes from private to public. Once the code and the episode are public, people will find the deployed services, and the paid paths (Twilio calls and texts, OpenAI voice and Decisions requests) bill the owner's accounts. Everything below is done by the owner in Railway, Twilio, OpenAI and GitHub; nothing in this repository changes those settings.

## 1. Turn off the paid paths

On the Railway app service, either stop the service or set all four feature flags to `false` and redeploy:

- `VOICE_ENABLED=false`
- `SMS_ENABLED=false`
- `DECISIONS_ENABLED=false`
- `CALLBACK_ENABLED=false`

With the service still running, check `GET /health` on your deployment. It should report `voiceEnabled`, `smsEnabled`, `decisionsEnabled` and `callbackEnabled` as `false`. With voice off, the app answers the Twilio call webhook with 404. Twilio may still bill for calls or texts to the number, so release the number or remove its webhook if you no longer need it.

A separate Railway project ("Web Dev Challenge", per reporting-ui/README.md and reporting-ui/docs/implementation.md) runs the reporting communicator (`reporting-ui/`, whose README says GPT-Live is enabled on its deployment) and the Expert Agent MCP server (`expert-agents-mcp/`, which runs OpenAI agents). Their addresses remain in the reporting UI's source and in `.sannr/stacks`. Turn their paid features off (for example `LIVE_ENABLED=false` on the reporting service) or stop them too. The MCP server skips bearer-token checks when `EXPERT_MCP_TOKEN` is empty, so confirm it is set if that service stays up.

## 2. Rotate every key that was ever pasted anywhere

Treat any credential that ever went into a chat, terminal transcript, issue, screen recording or shared document as exposed. Rotate it at the provider, then update the Railway variable. The app and its companions read:

- `OPENAI_API_KEY` (and any separate key used by the reporting or specialist services)
- `TWILIO_AUTH_TOKEN`
- `CONTEXT_API_TOKEN` and `REPORTING_API_TOKEN`
- the specialist MCP bearer token (`SPECIALISTS_MCP_TOKEN` on the caller's side, `EXPERT_MCP_TOKEN` on the server)
- the Postgres password. The [October journal](journal-2026-10.md) records an exposed Postgres password and public networking that were to be fixed after remote seeding; confirm both were done.

## 3. Confirm no .env is tracked

From the repository root:

```sh
git ls-files | grep -E '(^|/)\.env'
git log --all --diff-filter=A --name-only --format= | grep -E '(^|/)\.env' | sort -u
```

Both should list only `.env.example`, `expert-agents-mcp/.env.example` and `reporting-ui/.env.example`. Making the repository public publishes its whole Git history, not just the current files, so check the history as well as the tree.

## 4. Flip visibility

Change the repository's visibility in GitHub settings. Afterwards, open the public repository page while signed out and check that the README, LICENSE and NOTICE render.
