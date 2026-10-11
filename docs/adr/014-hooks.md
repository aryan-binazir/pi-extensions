# ADR 014: Tested hooks switched on in a tracked file

## Context

Guard enforced two hard-coded `gh` rules from a symlinked JSON file. Each new rule
meant new code, a new config schema and new setup docs, and Guard could only block.
Unattended runs also need rules that advise without blocking and rules that stop
the agent finishing too early. Pi has no configured hook commands; extensions
subscribe to typed events in process, where a hook check costs microseconds
rather than the milliseconds of spawning a process.

## Decision

One extension owns three hook types, each tied to one Pi event: block (`tool_call`,
stops the call with a reason), advise (`tool_result`, appends a note while keeping
structured content) and gate (`agent_before_settle`, appends its reason after other
extensions' boundary entries and requests one continuation). Every hook is a
tested TypeScript module in `extensions/hooks/catalog` with a stable id; hooks of
one type run in catalog order. The extension owns failure handling: a throwing
block hook blocks, a throwing advise hook is skipped, and a throwing gate is
reported without continuing. Gates run only after completed runs and continue at
most three times per human prompt; extension-sent input does not reset the cap.

`personal-settings/hooks.yaml` only maps hook ids to `true` or `false`; unlisted
hooks are off. The extension reads it from its own checkout on every event, so code
and switches always come from the same commit and travel with Git rather than a
per-machine symlink. Pi exports its YAML parser only through `parseFrontmatter`, so
the file may not contain document markers. A missing or invalid live file, including
unknown ids, blocks every tool except `read`, `grep`, `find`, `ls` and
`questionnaire`.

Built-in protection, outside the switches, lets agents switch hooks on but never
off. It covers every `personal-settings/hooks.yaml` resolved through symlinks, so a
worktree copy may enable a hook its own branch adds. Edits are simulated with Pi's
edit tool over in-memory operations, preserving its line-ending and fuzzy-matching
behavior. A change is allowed only if every enabled hook stays enabled, and for the
live file only if it names existing hooks. Bash that mentions the file may only
read, diff, add and commit it, without substitutions, redirections, assignments or
Git options that run programs or write output.

Pi 1.0.2 runs `tool_call` handlers in load order and stops at the first block, and
loads settings `extensions` entries before `packages`. The manifest lists hooks
first; setup loads hooks before Auto Permissions, so a blocked call never reaches
its reviewer while allowed calls still do. Subagents pass hooks as the first `-e`
extension and refuse to start when its entrypoint is missing.

## Consequences

Adding a hook is a code change with tests; switching it on is a one-line edit
agents may make, and switching it off is the user's. Guard's rules are the
`draft-prs` and `no-admin-merge` hooks, verified by Guard's ported behavior tests.
Bash parsing remains a workflow guardrail, not a sandbox: indirection such as
`bash -c`, scripts or earlier Git configuration can evade it. Two full-file writes
in one parallel batch are each checked against the file as it was, so the later
one can undo a hook the earlier one switched on, though never one enabled before
the batch. Gate messages in subagents stay in the child's session and do not yet
reach completion reports; no gate hook ships yet.
