# API context import — October 11, 2026

Sannr was installed in this repository before importing the API libraries. The standard `npx --yes @sannr/sannr@alpha connect` resolved to `0.1.0-alpha.10`; the repository then pinned that exact package locally and regenerated its own wiring. No original preparation repository was changed.

## Sources and contents

- The curated October 9 contestant packet V2 supplies five configured stacks, seven unbound OpenAI inventory entries, 133 authored notes, provider specifications and licenses, GOTCHAS, BUGS, source indexes and five opt-in request examples. Its ZIP SHA-256 is `4469fee7ebb81854e5a3fdde348531d2a10a2fd9e1508359386914cdc1767bd2`.
- The later October 9 OpenAI preparation adds 15 Live notes and ten user-supplied API reference documents. Two trial reports are explicitly historical and retain the unresolved delegation outcome. The earlier trial's “untested” wording was narrowed to its historical point in time; the later configuration trial is preserved separately.
- Total: **671 bound operations, seven unbound inventory entries, and 148 authored notes**. Of those notes, 24 describe Sannr client limitations scoped to alpha.10. No inherited operation is marked verified by execution here.
- [File provenance](import-manifest.json), [additional note provenance](additional-note-sources.json), and the [Live reference manifest](../../.sannr/stacks/openai/docs/live/manifest.json) retain hashes and attribution. Source labels identify the original relative locations; no private checkout is needed at runtime. Per-provider source indexes and spec licenses remain alongside their guides.

Whole named stack directories were copied, preserving the curated knowledge and note histories. New notes were retrieved, saved through Sannr's supported `note --alongside` command and retrieved again. Knowledge JSON was not manually rewritten. Source-root links in six Live references were expanded to their attributed documentation host; the reference manifest retains original and imported hashes. Examples now name their paths from this repository's root.

The curated source is deliberately narrower than the original working folders. Private API evidence, credentials, captured account/resource values, account-specific organizer correspondence, machine registrations, usage reports and failed-probe libraries were not imported. Account-state observations do not apply to a future reader's credentials. Full source workspaces and their history remain intact.

## Verification

- The standard pre-import onboarding doctor check made one unauthenticated `GET https://api.github.com/zen`: HTTP 200, 390 ms. This establishes that round trip only, not Twilio/OpenAI access; no API assertions or authentication were tested. Its receipt stays in ignored local evidence.
- After import, Sannr enumerated all six stack folders and retrieved all provider inventories. Each of the 15 added notes was saved and individually retrieved; its note-history state was healthy.
- Offline doctor passed contract readability, stack configuration, prefix routing, note-history checks for all 678 inventory operations, local MCP subprocess initialization, skill installation and generated instruction wiring. It exited 1 for the five configured environments' missing credentials. No provider request was made. It also reported the seven already-unbound OpenAI entries and an existing legacy launcher on this machine's PATH.
- An independent fresh copy in a path containing a space passed the locked npm installation, connect with network transports blocked, all six stack reads and a local STACK_REQUIRED refusal before transport when no stack was selected. Counts were 678 inventory operations, 148 notes and zero provider observations. Checks ran on macOS / Node v26.10.0; other operating systems and Node 22 were not separately tested.
- Source specification hashes, reference-document hashes, documentation links, credential exclusions and source-workspace preservation were checked. Known credential values were compared in memory, not copied into a report. Token-shaped Twilio account IDs occur only in hash-matching upstream specification examples.

The imported context is useful before credentials exist. Create your own local `.env` when needed. Live API access, billing, voice integration and the coding host's loaded MCP binding are separate checks. Open a fresh chat in this repository and say **Finish Sannr setup** to check that host binding; successful CLI or subprocess initialization alone does not establish it.

The repository is still private at import. No visibility change, public release or application license selection was made. The `private` field in package.json prevents accidental npm publication; it is independent of GitHub visibility and the eventual source license.
