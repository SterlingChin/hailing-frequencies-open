# Preparation history and export choices

October 6–9, 2026 source work, exported October 9 for all teams.

- Alpha.9 initially refused Twilio Basic authentication. Published alpha.10 later passed a scoped account-read regression; the shipped offline checks cover Basic-auth configuration and refusal behavior.
- OpenAI's older primary `/v1` capture/loader problem has an alpha.10 `/models` regression report. Seven literal-query-suffix entries remain unbound rather than being silently discarded.
- Initial OpenAI metadata success preceded exhausted-credit generation failures; later generation and Structured Outputs preparation checks succeeded after credits were added. That is a historical sequence, not a status report for the recipient's account.
- The original larger probe library includes failed attempts, retries, credential minting and resource cleanup work. It is deliberately not a runnable appendix here. The useful observations are retained as edited operation notes, with source-note hashes and current limitations in BUGS. The supplied examples are a much smaller opt-in set.
- Prior request-count totals and sub-ten-cent spending estimates were not reconciled with billing. They are not reproduced as verified results.
- Original BUGS/HANDOFF files mixed private account history and development chronology. This export provides concise shared summaries instead. It also excludes the original show concept and organizer correspondence.
- Prior execution stores, learned field values and verification flags were removed from the new knowledge files. A historical author report is not relabeled as an execution by your team. Original workspaces and evidence were not changed.

## Attribution

Prepared from Sterling Chin's CodeTV API preparation with Sannr. Public Twilio and OpenAI specifications are copied without modification, retain their source commits/hashes and licenses under each `specs/` folder, and are subject to those licenses. The Sannr package is installed from npm under its own license. Package instructions and edited notes are supplied for contestants to use and adapt for their builds; no provider endorsement is implied.

## Version 2

Sterling confirmed reusable API prep only. The show concept remains excluded. Added 24 version-scoped Sannr client limitations directly to affected operations (20 OpenAI / 4 Twilio), preserving the previous 109 authored notes. All 133 notes travel inside the stack files. The new notes were saved and individually retrieved using the pinned CLI without provider traffic. General setup/reporting issues stay in BUGS.md; operation-specific limitations now appear during relevant Sannr retrieval.
