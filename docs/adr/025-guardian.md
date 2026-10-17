# 025: Guardian, a port of Codex's approval stack

Status: accepted.

## Context

Auto Permissions reviews every Bash command with a model and no sandbox, so every command waits
on a review and the reviewer carries the whole safety burden. Codex instead runs commands in an OS
sandbox, lets exec-policy rules decide what they can, and asks its Guardian reviewer only for
actions that leave the sandbox. Our inspiration from this code comes from there. The source is
openai/codex at `ce0323f2f2d3b25e82806cd555237da3db4e1897` (Apache-2.0).

## Decision

`extensions/guardian/` translates Codex module by module, with Codex's tests:

| Pi module | Codex source |
| --- | --- |
| `rules.ts`, `amend.ts` | `execpolicy/src/{decision,rule,policy,parser,amend}.rs`, `execpolicy/tests/basic.rs` |
| `shell.ts`, `shlex.ts` | `shell-command/src/{bash,shell_detect}.rs`, `command_safety/is_dangerous_command.rs`; the `shlex` crate |
| `exec-policy.ts` | `core/src/exec_policy.rs` and its tests |
| `seatbelt.ts`, `seatbelt/*.sbpl` | `sandboxing/src/seatbelt.rs` and its policies; workspace-write lowering in `protocol/src/permissions.rs` |
| `bwrap.ts`, `synthetic-mounts.ts` | `linux-sandbox/src/{bwrap,linux_run_main}.rs` |
| `bwrap-launcher.ts` | `sandboxing/src/bwrap.rs`, `linux-sandbox/src/{launcher,bundled_bwrap}.rs`, `install-context/src/lib.rs` |
| `seccomp.ts` | `linux-sandbox/src/seccomp.rs` |
| `sandbox.ts` | platform selection in `sandboxing/src/manager.rs`; `sandboxing/src/denial.rs` |
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

- Seatbelt on macOS and bubblewrap on Linux; other platforms have no sandbox, and every command and
  file change is reviewed as an escalation.
- On Linux, Codex re-executes its own helper inside bubblewrap to install seccomp. Guardian emits the
  same rules as a classic BPF program and passes it to `bwrap --seccomp`, so it never needs `--argv0`.
  The x86-64 filter also rejects x32-ABI syscall numbers, which seccompiler leaves open.
- Without a system bubblewrap, Guardian uses the one bundled with the Codex install on `PATH`. Codex
  checks its bundled copy against a SHA-256 digest compiled into its build; Guardian cannot know that
  digest and relies on Codex's other check, that the sandbox cannot replace the binary.
- When bubblewrap cannot create user namespaces, Codex warns and still runs commands through it, so
  each fails. Guardian treats that as having no sandbox and reviews every command.
- Codex probes `/proc` mounting before every command; Guardian probes once per bubblewrap and network
  mode. Codex locks its placeholder registry with flock(2); Guardian shares that registry and lock
  through util-linux's flock(1), serializing its own registrations in-process.
- Not ported on Linux: WSL interop masks, deny-read globs, Codex's app-server socket masks, the
  proxy-routed network mode, and the legacy Landlock pipeline.
- Network is all or nothing; there is no managed proxy or per-host approval.
- The reviewer is one model loop with a single read-only `exec_command` tool in the read-only
  sandbox, not a forked Codex session. It gets the full transcript on every review, with
  no session reuse or deltas. Codex's whole-request budget admission is reduced to a fixed transcript
  budget, because Pi does not know every reviewer's input limit: the oldest user entries are shortened
  first, keeping both ends, and omitted only when that is not enough.
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
  exposed in `config.json`; `approvalPolicy` offers `on-request`, `untrusted` (also spelled
  `unless-trusted`) and `never`.
- Claude reviews through `claude -p` (`review/claude-cli.ts`) with `--safe-mode` and read-only tools.
  Pi's `claude-bridge` provider only serves prompts captured through Pi's own agent lifecycle, so it
  cannot answer a review; configuring it is an error that names `claude-cli`.
- `.pi` joins Codex's protected metadata names, because Pi loads project extensions and settings from it.
- The Railway boundary lives in code (`railway.ts`), not in a `.rules` file, and is checked before rules,
  settings and review, including when Guardian is disabled. A data file under a writable checkout could be
  edited, deleted or left unparsed, and the boundary must not depend on that. It normalizes wrappers,
  package runners, package versions, paths and flags, refuses any script that names Railway beside a
  destructive word, accepting false refusals on harmless text, and reviews calls to Railway's data hosts.
  The bundled `.rules` file remains as defence in depth, and the reviewer's absolute deny is built in.
- "Don't ask again" is only offered, and a prefix only persisted, when it cannot widen a boundary:
  prefixes that invoke the Railway CLI, wrapper commands and Codex's banned suggestions never become
  standing allow rules. Package runners persist as in Codex.
- Under `approvalPolicy: never` without a sandbox, commands no rule allows are rejected rather than run.
- Approval requests for writes name the file a link resolves to, and the approved write goes to that
  file.
- Claude runs with `--restricted --setting-sources ''` from a temporary directory outside the reviewed
  workspace, with `--add-dir <cwd>` for reads. Otherwise a `.claude/settings.json` written in the
  workspace could make the reviewer run a helper command on the host.
- The reviewer model is resolved per review, and a `~fast` alias falls back to its plain model, so a
  session without Fast mode (a subagent child) still reviews instead of rejecting every approval.
- Sandboxed commands finish the way Pi's own bash does: after the command exits, output is read until
  the pipes close or fall idle for 100 ms, so a backgrounded process does not hold the tool call open
  and output still in the pipe is kept.
- Subagent children of a parent running Guardian load it alongside hooks and refuse to start without it, so
  a child inherits the parent's sandbox, rules and review; children of a parent without it match the parent.
- A Guardian that cannot start (unreadable bundled files, a parser that fails to load) still replaces `bash`,
  `write` and `edit` with tools that refuse, so Pi never falls back to its unguarded tools. A broken bundled
  rules file only drops those rules; the Railway boundary in code still applies.
- A destructive statement through a database client (`psql`, `mysql`, `mongosh`, `redis-cli` and others) or a
  database wipe tool (`dropdb`, `prisma migrate reset`, `rails db:drop`) is reviewed even inside the sandbox:
  its target usually comes from credentials Guardian cannot see, so it may be a Railway database.

## Verification

Each module's `*.test.ts` ports the corresponding Codex tests. Seatbelt tests run the real
`sandbox-exec` on macOS, and `sandbox.test.ts` ports Codex's Linux sandbox suite against the real
`bwrap`. Shell, file and session tests run against whichever sandbox the platform has. The seccomp
program is checked by a BPF interpreter for both architectures; its syscall numbers were compared once
by hand against libseccomp's `scmp_sys_resolver`, not in the tests. `index.test.ts` drives full Pi sessions in which a scripted model plays
both the agent and the reviewer. `railway.test.ts` evaluates the Railway rules without running
any Railway command.
