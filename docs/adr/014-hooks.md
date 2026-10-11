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
structured content) and gate (`agent_before_settle`, keeps the boundary entries
earlier handlers proposed, appends its reason and requests one continuation).
Every hook is a tested TypeScript module in `extensions/hooks/catalog` with a
stable id; hooks of one type run in catalog order. The extension owns failure
handling: a throwing block hook blocks, a throwing advise hook is skipped, and a
throwing gate is reported while later gates still run. Gates run only after
completed runs and continue at most three times per human prompt;
extension-sent input does not reset the cap.

`personal-settings/hooks.yaml` only maps hook ids to `true` or `false`; unlisted
hooks are off. The extension reads it from its own checkout on every event, so code
and switches always come from the same commit and travel with Git rather than a
per-machine symlink. Pi exports its YAML parser only through `parseFrontmatter`, so
the file may not contain document markers. An empty `hooks` mapping switches
everything off. A missing or invalid live file blocks every tool except `read`,
`grep`, `find`, `ls` and `questionnaire`. Ids switched on that the running code
does not know, because a pull added them, are ignored with a one-time `/reload`
notice so known hooks keep running.

Built-in protection, outside the switches, lets agents switch hooks on but never
off. It covers every `personal-settings/hooks.yaml` resolved through symlinks, so a
worktree copy may enable a hook its own branch adds. Edits are simulated with Pi's
edit tool over in-memory operations, preserving its line-ending and fuzzy-matching
behavior. A change is allowed only if every enabled hook stays enabled, and for the
live file only if it names existing hooks. Pi checks every call in a parallel batch
before running any, so each switches file accepts one change at a time until its
result arrives or the turn ends. Bash that names the file in a path-like word, or
anywhere alongside a command substitution, may only read, diff, add and commit it,
without redirections, assignments or options that run programs or write output.
Spaced `gh` and `git` arguments are titles, bodies and messages, not paths.

On the Pi 1.0.2 runtime (tests use the 0.99.1 SDK), `tool_call` handlers run in
load order and stop at the first block, and settings `extensions` entries load
before `packages`. The manifest lists hooks
first; setup loads hooks before Auto Permissions, so a blocked call never reaches
its reviewer while allowed calls still do. Subagents pass hooks as the first `-e`
extension and refuse to start when its entrypoint is missing.

## Consequences

Adding a hook is a code change with tests; switching it on is a one-line edit
agents may make, and switching it off is the user's. Guard's rules are the
`draft-prs` and `no-admin-merge` hooks, verified by Guard's ported behavior tests.
Bash parsing remains a workflow guardrail, not a sandbox: indirection such as
scripts, aliases or earlier Git and `gh` configuration can evade it. Gate messages
in subagents stay in the child's session and do not yet reach completion reports;
no gate hook ships yet.
