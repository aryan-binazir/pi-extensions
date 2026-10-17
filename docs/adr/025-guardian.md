# 025: Guardian, a port of Codex's approval stack

Status: accepted.

## Context

Auto Permissions reviews every Bash command with a model and no sandbox, so every command waits
on a review and the reviewer carries the whole safety burden. Codex instead runs commands in an OS
sandbox, lets exec-policy rules decide what they can, and asks its Guardian reviewer only for
actions that leave the sandbox. Our inspiration from this code comes from there: openai/codex at
`ce0323f2f2d3b25e82806cd555237da3db4e1897` (Apache-2.0).

## Decision

`extensions/guardian/` translates Codex module by module, with Codex's tests:

| Pi module | Codex source |
| --- | --- |
| `rules.ts`, `amend.ts` | `execpolicy/src/{decision,rule,policy,parser,amend}.rs`, `execpolicy/tests/basic.rs` |
| `shell.ts`, `shlex.ts` | `shell-command/src/{bash,shell_detect}.rs`, `command_safety/is_dangerous_command.rs`; the `shlex` crate |
| `exec-policy.ts` | `core/src/exec_policy.rs` and its tests |
| `seatbelt.ts`, `seatbelt/*.sbpl` | `sandboxing/src/seatbelt.rs` and its policies; workspace-write lowering in `protocol/src/permissions.rs` |
| `permissions.ts` | `prompts/src/permissions_instructions.rs` and templates |
| `bash.ts` | `core/src/tools/{orchestrator,sandboxing}.rs`, `handlers/shell_spec.rs`, `sandboxing/src/denial.rs` |
| `files.ts` | `core/src/safety.rs` |
| `review/claude-cli.ts`, `review/process.ts` | no Codex counterpart: Claude Code print mode, bounded subprocesses |
| `approvals.ts` | `ext/guardian-reviewer/src/{routing,review}.rs`, `core/src/tools/approvals.rs`, `context/guardian_approved_action.rs` |
| `review/*` | `guardian-context/src/*`, `ext/guardian-reviewer/src/{assessment,outcome,retry,completion,circuit_breaker}.rs`, `prompts/src/guardian_instructions.rs`, `prompts/templates/guardian/*` |

Shell parsing uses `web-tree-sitter` with `tree-sitter-bash` 0.25.1, the grammar version Codex
pins, so the plain-command and dangerous-command parsers behave as Codex's do. Preferences use
Codex's names in one JSON file (see [Guardian](../guardian.md)). The reviewer is any model in Pi's
registry rather than a catalog entry.

## Departures from Codex

- macOS Seatbelt only. Without it, every command and file change is reviewed as an escalation.
- Network is all or nothing; there is no managed proxy or per-host approval.
- The reviewer is one model loop with a single read-only `exec_command` tool under the read-only
  Seatbelt profile, not a forked Codex session. It gets the full transcript on every review, with
  no session reuse, deltas, or whole-request budget admission.
- Pi has no developer role. Reviewer policy and permissions go in the system prompt; AGENTS.md files
  and environment context lead the user message.
- Pi keeps the whole session branch, so earlier user messages appear in the transcript directly
  instead of in Codex's retained-instructions section. Questionnaire answers are host-verified
  answers.
- Write and edit run in-process, so Guardian overrides both tools and gates each mutation at the path Pi
  resolved, canonicalizing it against the sandbox's writable roots instead of applying patches inside the
  sandbox. Leaf symlinks are followed, multi-link files are never written automatically, and parent
  directories are created only after approval.
- A timed-out or failed review asks you when a UI is available (`autoReview.failureFallback`).
  Codex rejects to the agent. A failed review never approves.
- Under `approvalPolicy: never`, escalation requests are rejected outright.
- Not ported: MCP tool review, network-access approvals, `with_additional_permissions`,
  `request_permissions`, async scoring, and the stale-authorization retry.
- `.rules` files are parsed as the call-and-literal subset Codex's own rules files use. Codex evaluates
  them as Starlark, so rules built from variables or expressions are rejected rather than mis-evaluated.
- Codex's granular approval policy is ported in `exec-policy.ts`, because its tests cover it, but is not
  exposed in `config.json`; `approvalPolicy` offers `on-request`, `unless-trusted` and `never`.
- Claude reviews through `claude -p` (`review/claude-cli.ts`) with `--safe-mode` and read-only tools.
  Pi's `claude-bridge` provider only serves prompts captured through Pi's own agent lifecycle, so it
  cannot answer a review; configuring it is an error that names `claude-cli`.
- `.pi` joins Codex's protected metadata names, because Pi loads project extensions and settings from it.
- Guardian's bundled rules are evaluated separately from user rules and bind even when Guardian is
  disabled, matched against the literal commands Codex extracts for its `rm -f` check, so a hard deny
  cannot be configured away or hidden inside a wrapper.
- Subagent children load Guardian alongside hooks and refuse to start without it, so a child inherits the
  parent's sandbox, rules and review.
- Destructive Railway operations are forbidden by bundled rules and an absolute reviewer deny that
  config cannot remove.

## Verification

Each module's `*.test.ts` ports the corresponding Codex tests. Seatbelt tests run the real
`sandbox-exec` on macOS. `index.test.ts` drives full Pi sessions in which a scripted model plays
both the agent and the reviewer. `railway.test.ts` evaluates the Railway rules without running
any Railway command.
