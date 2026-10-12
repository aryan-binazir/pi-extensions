# ADR 015: Delegation admission

Status: accepted

[ADR 008](008-subagents-workflows.md) defines child permissions and workflow
replay. The checks previously lived partly in the extension, registry and
workflow runner. Each caller assembled the parent scope and selected its own
checks. Tool classification, reader restrictions and connector checks appeared
in several places.

`DelegationAdmission` in `extensions/subagents/scope.ts` owns that policy. It
accepts raw Pi facts and constructs the live parent scope itself. Profiles still
parse configuration and resolve model/thinking selections; admission owns when
that resolution and its validation run. Shared task types and constants live in
`task.ts`, removing the registry/profile type cycle. The registry owns structural
task validation; admission supplies its tool-selection policy at the existing
point in that validation sequence, preserving error order.

## Interface and phases

| Entry | Responsibility |
| --- | --- |
| `direct` | Validate raw fields, resolve cwd/profile/model/thinking, reject explicit tools outside parent scope, and prepare the connector bridge. This remains synchronous before registry admission. |
| `queue` | Validate the task, select permitted defaults, enforce reader limits, validate bridge definitions and their frame budget, canonicalize cwd, enforce workspace/sensitive-path limits, and approve explicit extensions. Return the task, bridge and writer classification separately. |
| `launch` | Recheck current tools, configuration/trust identity and model availability synchronously before process launch. |
| Connector bridge `execute` | Recheck the spawning parent cwd, configuration identity, selected connector scope, reader grant and spawning context's callable tools before parent execution. |
| Workflow `admit` | Resolve each raw stage against the captured configuration and parent model/thinking selection. Reject changed configuration/workspace and child cwd escapes. Live stages still enter registry `queue` and `launch`. |
| Workflow `request` | Prepare a live stage's bridge using the captured spawning context. Cached stages never request a bridge. |
| Workflow `replay` | Recheck the admitted cached task's current workspace/tools and approve its extensions again, without launching or requiring a live bridge. Every cached stage first passes workflow `admit`. |
| Workflow `read` | Require current read permission and reject workspace escapes and sensitive paths. The workflow runner retains bounded file I/O and substitution checks. |

The registry requires an admission port containing both `queue` and `launch`.
It owns admission deadlines, abort signals, queue capacity, writer serialization
and subprocess supervision. It retains brief/cwd/timeout/extension structural guards even for a custom
admission port. It consumes admission's writer classification and bridge, without
interpreting tool grants. The presence of a bridge selects child proxy loading. Extension approval stays inside its
admission deadline. Callers cannot omit the launch check by supplying a custom
process invocation.

## Compatibility

This refactor preserves error strings and their existing validation order.
Different phases retain their distinct errors. Declined extension approval keeps
`retryable: false`. Live child approval and cached-stage approval retain their
separate UI titles and signals.

Workflow journals hash the complete validated task, including property order.
Admission preserves the existing output shape and spread order. Writer/bridge
metadata stays outside that task. Workflow identity retains the `defaults`
payload containing captured parent model/thinking, even though production stage
resolution uses named profiles. The dead default-task merge and thinking-suffix
inheritance are removed; no existing test exercised that fallback. The unreachable selected-model checks
are removed too. Standalone workflow tests now supply an explicit admission
fixture instead of using a production fallback.

The refactor preserves one existing gap: cwd is checked at queue admission, but
launch does not repeat the cwd check. Configuration identity does not always
change when an untrusted parent changes cwd. Adding that rejection would change
which queued tasks launch and needs a separate behavior decision. Forwarded
calls and workflow stage admission retain their explicit cwd-change checks.

The cancellation/completion lifecycle, workflow journal implementation and
nearby editor extensions remain outside this decision.

## Verification

Admission tests exercise direct requests, queue checks, launch drift, forwarded
connector calls, cached replay, workspace changes and extension approval through
the module interface. A golden JSON literal captured from the pre-refactor validator after profile
resolution pins production task shape and property order, with paths normalized
for portability. Real hanging extension approvals exercise admission deadlines
and shutdown through the registry. Existing registry, workflow and registered
extension integration tests retain their supervision and replay coverage.
