# 027: Offline Guardian approval statistics

Status: accepted.

## Context

Guardian already records approval decisions and handling durations in Pi custom entries. We need
evidence about their frequency and cost without changing permissions, adding instrumentation or
exposing conversation content. Session forks can copy decisions; a request can have automatic,
human and policy decisions. These records do not identify runtime retries or prove execution.

## Decision

`extensions/guardian/audit-stats.ts` owns bounded JSONL parsing, metadata deduplication, request
aggregation, timing statistics and coarse operation classification behind `auditStats`. Its guarded
CLI accepts explicit files or stdin and emits aggregate JSON or text. It is not a Pi extension
entrypoint and does not import approval routing or configuration at runtime.

Use the existing literal shell parser on the recorded Bash argv, including any configured command
prefix. Multiple plain commands are compound; unsupported syntax is unknown. Categories describe
recorded actions and never imply escalation cause or permission safety.

Deduplicate canonical audit data for records with request IDs, including copies across files.
Preserve distinct decisions sharing a request ID; report overlapping, order-independent outcome
flags rather than inventing a final chronological outcome. Missing IDs remain unkeyed decisions.
Separate manual approval handling from user prompt handling. Exact nearest-rank percentiles retain
valid integer duration samples within fixed input/record limits; large totals use decimal strings.

## Consequences

Only fixed labels, aggregate numbers and static explanations leave the module. Input errors never
echo paths or source. Limits and exclusions are explicit; an incomplete report has a distinct exit
status. No automatic session discovery is provided. Callers choosing real sessions must establish
repository provenance and avoid passing unrelated transcript content to a model.

The diagnostic reads existing metadata only. Approval routing, sandbox boundaries, standing rules,
caching and runtime behavior remain outside its scope. Synthetic module and CLI tests verify its
privacy and counting contracts.
