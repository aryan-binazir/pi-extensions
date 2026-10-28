# 028: Guardian connector leaf approvals

Status: accepted.

## Context

Shell/file approvals and delegated connector grants do not authorize each external mutation.
Pi routes direct, codemode and delegated parent leaf calls through the same `tool_call` hook.

## Decision

`guardian/connectors.ts` owns classification and the leaf gate. Recognize Pi's supported `builtin:mcp`
source and exact user-declared connector names, excluding core tools and child forwarding proxies.
Read-only hints are unverified; conflicting destructive hints require review. Exact `alwaysReview`
wins over both hints and `readOnly`. Other calls use the existing `Approvals` reviewer/fallback path.
`never` refuses review-required connector calls. Resolve metadata per call for late registration.

Review the complete bounded action, without a potentially huge schema. Connector requests opt into
metadata-only audit: no argument values/hashes, reviewer text, context hashes or manual replay.
Shell/file audit behavior stays unchanged. The server's validated arguments and result/error remain
Pi's responsibility. No wrapper executes connector tools or replaces the delegation grant checks.

## Consequences

Mutations add per-call latency and batches have no rollback. Independent child cancellation can leave
a review running until it settles, but Pi rechecks cancellation before execution. Trusted extensions
can mutate arguments after this hook. This authorization boundary assumes honest host-privileged
servers; it does not sandbox them. [Guardian documentation](../guardian.md#connector-approvals)
describes exact declarations, config failure limits and transcript privacy limits.
