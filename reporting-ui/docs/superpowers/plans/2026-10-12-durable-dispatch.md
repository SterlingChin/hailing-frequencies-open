# Durable reporting dispatch

Implement main's claim_before_dispatch and reconcile_existing policies without changing upstream contract/source files. Store exclusive claims and atomic receipts on a Railway persistent volume, scoped by the returned dispatch_key. Never automatically replay a claimed call with an uncertain result.

1. Test exclusive claims across store instances, receipt persistence after recreation, and uncertain claim reconciliation.
2. Implement file-backed claims using exclusive creation, file and directory fsync, and atomic receipt replacement. A malformed/partial existing claim remains unknown.
3. After tools/list and argument validation, claim before tools/call. Reused actions read saved receipts without issuing new expert work. Save projected outcomes and subsequent collected status.
4. Test router restart/reuse, concurrent callers, and lost response behavior with scripted MCP transports.
5. Mount a Railway volume at /data; configure the dispatch directory and initialize ownership before dropping to the node runtime user.
6. Review and run UI/MCP/backend checks, update PR #15, merge latest main and PR, then deploy and verify configuration/health without launching expert work.
