# API preparation

Start with the [project setup](../../README.md). Both provider libraries share this repository's Sannr installation, but their hosts, credentials, contracts and context remain separate.

| Material | OpenAI | Twilio |
| --- | --- | --- |
| Routing and credentials | [OpenAI](openai/README.md) | [Twilio](twilio/README.md) |
| API lessons | [GOTCHAS](openai/GOTCHAS.md) | [GOTCHAS](twilio/GOTCHAS.md) |
| Client limitations | [BUGS](openai/BUGS.md) | [BUGS](twilio/BUGS.md) |
| Opt-in request examples | [Examples](openai/examples/README.md) | [Examples](twilio/examples/README.md) |
| Public spec attribution | [Sources](openai/specs/provenance.json) | [Sources](twilio/specs/provenance.json) |

The full operation notes are in `.sannr/stacks/<name>/sannr.json` at the repository root. On supported setups, retrieve the matching operation with `sannr show` before issuing a request. Otherwise read the JSON directly. Do not rely only on the shortened gotchas in generated AGENTS.md: its display is capped.

For voice work, start with [VOICE-PREP.md](VOICE-PREP.md), the [Live reference archive](../../.sannr/stacks/openai/docs/live/README.md), and the notes on `POST /live/sessions`. The October 9 WebRTC reports establish session creation and an unresolved delegation problem, not a completed voice integration. Later creation trials do not prove that the earlier failure was fixed.

The October 9 contestant packet contributes 133 notes; 15 subsequent OpenAI Live notes bring this import to 148. They retain attribution and original dates. None is a new provider verification. Client limitations are labeled alpha.10; do not reinterpret them as provider defects.

[IMPORT.md](IMPORT.md) records what was copied and checked. Source API workspaces, private evidence and account-specific organizer reports remain outside this repo.
