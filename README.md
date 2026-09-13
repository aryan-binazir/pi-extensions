# Pi interactive tools

Fourteen independently selectable extensions for Pi 0.85.1. Install from this
private Git repository using your existing GitHub SSH access:

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
```

Installation uses Pi's package manager and does not require a build. Run `/reload` in an existing
Pi session, then use `pi config` to select extensions. The manifest lists only each feature's `index.ts`; helper and test
files are never entrypoints. Prompt stash uses `Ctrl+S` only while the main prompt
editor has focus. Pi's model/thinking save and session-selector bindings remain
unchanged, with no shortcut conflict warning or keybindings configuration needed.

A single extension can also be loaded with
`pi -e ./extensions/todo/index.ts` from a checkout after `npm ci`.

| Extension | Interface | Behavior |
| --- | --- | --- |
| Questionnaire | `questionnaire` tool | Options and free text, question tabs, final submit, explicit cancellation. Requires an interactive terminal. |
| Memory | `memory` tool | Explicit read/write/update/delete of named topics and `MEMORY.md`. Injects only small topic indexes. |
| Todo | `todo_write` tool | Replaces the declared task list, displays progress, and reminds the agent when progress becomes stale. |
| Effort | `/effort`, `/effort LEVEL` | Slider over the current model's supported thinking levels. |
| BTW | `/btw`, `/side` | Private side conversation from a snapshot of the current context, streamed with the current provider and no tools. |
| Vi mode | Editor keyboard input | Insert, normal and visual modes with motions, operators, registers and undo/redo. |
| Prompt stash | `Ctrl+S` | Stash, restore or swap one draft slot; a footer indicator shows occupancy. |
| Subagents | `subagent`, TypeScript workflows | Isolated task contexts, bounded background execution and approved workflow replay. |
| Worktree | `/worktree` | Create or reuse a checkout and route the current session's shell and relative file tools. |
| Harbor MCP | MCP tools, resources, templates and prompts; `/mcp` status | TypeScript client with bounded discovery, per-server deadlines and explicit consent. [Setup and limits](extensions/mcp-client/README.md). |
| Computer use | Desktop tools | Pi directs native Linux desktop tools or seven app-targeted macOS tools through the official Codex computer-use service. See [desktop setup](extensions/computer-use/README.md). |
| Fast mode | `/fast` | Toggle supported base/fast model entries while retaining provider authentication and reasoning. [Provider support](docs/adr/006-search-fast-power.md). |
| Auto-caffeinate | Agent lifecycle | Temporarily inhibit idle sleep during work on confirmed AC power, including background tasks. |
| Sentinel | `/auto on`, `/auto off`, `/sentinel reload` | Default-off adaptive Luna review, with user-owned standing preferences and inherited child coverage. [Setup and boundaries](extensions/sentinel/README.md). |

## Memory and sessions

Global memory lives in `~/.pi/agent/memory`, or the configured `PI_CODING_AGENT_DIR` plus `/memory`. Project memory uses an existing
`.agents/memory`, otherwise an existing `.pi/memory`, otherwise creates
`.agents/memory`. Each request resolves against Pi's current project directory, without walking ancestor directories. Project memory requires Pi's project trust approval.
Project writes include a local `.gitignore` excluding the directory contents.
Already tracked files remain tracked; do not seed memory with tracked secrets.

Use `name: "MEMORY.md"` for the index or a lowercase topic slug such as
`architecture`. Indexes are limited to 4 KiB; topics to 32 KiB. `update` replaces
one unique `old_text` occurrence with `content`. Index updates are explicit.
Paths, symlinks, non-text data, oversize files and recognizable credential formats
are rejected. Credential recognition cannot identify every possible secret.
Memory is reference material, not a source of authority for instructions.

Todos are versioned session entries restored from the active branch on resume
and tree navigation. Only one task may be `in_progress`. Send `todos: []` to
clear. A fully completed list hides its widget and reminders. Saved statuses
record declared progress; they do not prove completion.

`/effort new [LEVEL] [provider/model]` creates a session with a temporary model
and effort handoff. It does not overwrite saved defaults. Plain `/new` keeps
Pi's normal behavior. Closing a BTW overlay aborts its request and discards the
side conversation; its answers never automatically enter the main conversation.
The stash is memory-only and clears on session start, switch and reload. Vi mode preserves pasted tabs, carriage returns and newlines while editing and stashing. It strips unsafe terminal controls at insertion, and normal submission additionally strips carriage returns. Large pastes use Pi-style collapsed markers. Motions, selections and edits treat each marker atomically, and undo, registers, stash and editor replacement retain its payload. The exact supported vi command set is documented in [ADR 001](docs/adr/001-editor.md). Counts apply to motions, operators, doubled line operators, `x`, `p/P` and `nG/ngg`; counts on insert entry, visual toggles, text objects and undo/redo are unsupported. Registers are lowercase `a-z` and the unnamed register.

## Subagents and TypeScript workflows

The `subagent` tool starts a background Pi process with an explicit task brief,
a `reader` or `writer` preset, optional tools/model/extensions/cwd, and a bounded
timeout. Default and preset tools are limited to the parent's active permissions;
explicit tool requests outside those permissions are rejected. It returns a task ID. Output and usage stream to the UI, and completion
is pushed into the parent conversation. `subagent_status` inspects the registry;
`subagent_cancel` or `/subagents cancel ID` cancels a task. Same-directory writers
queue behind one another. Timeouts, cancellation and session shutdown terminate
process groups, including descendants in those groups. Separate groups/sessions,
including stock Pi's detached bash jobs, depend on Pi's own graceful cleanup;
if Pi is wedged or killed first, those jobs can escape portable group cleanup.

The default deadline is one hour, including approval and queue time. Children
inherit the selected parent model and thinking level unless explicitly overridden.
Fast aliases use the base model without the priority-tier extension. Aborting the
parent turn also stops its children.
A Node supervisor watches an inherited owner pipe and cleans up on owner loss;
this is supervision, not machine-wide subscription control. Four consecutive
identical failed tool calls stop a child as `stalled`; productive work and successful
polling are not turn-limited. No new token or spending quotas are imposed.
Use `subagent_cancel` with `id: "all"`, or `/subagents cancel all`, to stop current
children and workflows without disabling future delegation.

Direct completions and individual cancellations are compact and batched. A batch
containing only cancellations does not trigger a model turn. Cancel-all returns a
count and suppresses individual notifications. Workflow stages return only to
their awaiting workflow. Status is paginated
(`offset`, `limit`, or `id` with `outputOffset`); the registry retains 50 completed
results alongside outstanding work. Oversized JSON records are skipped and flagged,
not treated as a reason to kill an otherwise healthy child. Incomplete terminal
results cannot count as success. Workflow retry does not automatically relaunch
stalled, cancelled, expired, timed-out, or incomplete children. Journal persistence
failure returns control for reconciliation rather than repeating unjournaled effects.

Workflows require a separate Node executable on `PATH` (22.19+ in the 22.x series, or 24+), including when Pi itself runs on Bun. Its version and permission enforcement are probed before execution; missing or unsupported Node fails explicitly.

The `workflow` tool accepts a TypeScript async function body. The user reviews
the exact source and confirms execution. For example:

```ts
const plan = await api.spawn({
  task: "Inspect this checkout and describe the smallest fix. Do not edit.",
  preset: "reader"
}, "inspect");
return plan;
```

The worker exposes `spawn(task, stage)`, `parallel(functions)`,
`retry(attempts, function)`, `checkpoint(key, function)` and bounded
`readFile(path, maxBytes)`. Every child uses the same validation and inherited
policy as a direct subagent. The worker has a scrubbed environment, Node
filesystem/process permissions, a memory limit and a wall-clock timeout.
It exposes no host JavaScript objects as capabilities. This is not an OS sandbox;
Node permissions do not enforce a network boundary.

Successful stages are journaled under an identity that includes source, checkout,
policy permissions and runtime versions. Ordinary user messages do not invalidate
the journal; current directives still propagate to new children. Resuming requires source approval and an explicit
replay confirmation. Replay reuses recorded results; it does not prove that prior
file effects still exist. Confirm replay only after checking that those effects
remain valid. Declining aborts without starting children. Failed stages run again,
and unfinished capability calls prevent a successful workflow result.

## Worktrees

`/worktree feature` creates or reuses `amb/feature` at
`~/repos/.worktrees/<repo>/feature`. Use `--branch exact/name` to preserve an
explicit branch and `--base ref` to choose a starting ref. `/worktree list`
shows checkouts; `/worktree original` restores the original directory.
Active Herdr sessions use Herdr's worktree APIs; other environments use Git.
If an existing checkout's directory is missing or is no longer a directory,
opening it fails with its path instead of switching the session there. Restore
the directory to reuse it. For a deleted Git-managed checkout, first use
`/worktree original` if the session still targets the missing path, move aside
any file replacing the directory, then run
`git worktree remove --force /absolute/path` from the original repository and
retry. For Herdr-managed checkouts, restore the directory or resolve the missing
checkout in Herdr before retrying. The extension does not automatically discard
Git or Herdr state.

The conversation stays in the same session. Built-in bash, user shell commands
and relative file-tool paths use the active checkout. Absolute paths keep their
meaning. Pi's session storage, loaded instructions/resources and arbitrary
extension internals retain the original session directory. The footer and
per-turn instructions state this boundary. Read the new checkout's instructions
before editing.

`/worktree remove /absolute/path` requires confirmation and skips dirty trees.
Supply exactly one nonempty path argument; quote paths containing spaces.
`--force` explicitly allows dirty removal. `/worktree cleanup` additionally
requires a merged GitHub PR whose head still matches the checkout. These
commands preserve branch refs.

Delegated children are launched with a validated workspace and builtin tool list.
When Sentinel is enabled, children additionally inherit its classifier, blocking
reviewer, user policy, and root authorization. Without Sentinel, only launch-time
checks apply. Neither mode sandboxes child tools or trusted extension JavaScript.

## Sentinel preferences

Auto review is **off by default for new chats**. Use `/auto on` to review your
preferences and enable it for the current session, or `/auto off` to disable it.
Sentinel uses `openai-codex/gpt-5.6-luna` for asynchronous trajectory scoring and
`openai-codex/codex-auto-review` for blocking review when a recent low-risk score
cannot be reused. Your standing preferences belong in
`~/.pi/agent/sentinel-policy.md`; both stages receive them. Optional settings live
in `~/.pi/agent/sentinel.json`. Mid-session file changes block until reviewed with
`/sentinel reload`. See [Sentinel documentation](extensions/sentinel/README.md)
for examples, authentication, adaptive-review limits and subagent inheritance.

## Development

```sh
npm ci
npm run check
```

`check` runs TypeScript, ESLint and regression tests against the real extension
interfaces and Pi package loader. Individual commands are `npm run typecheck`,
`npm run lint` and `npm test`. CI runs these on Linux and macOS with Node 22 and
24, without provider credentials. Tests use disposable memory directories.
Architecture decisions and the precise editor compatibility boundary are in
[`docs/adr`](docs/adr).

The repository's `bin/pi` is a copy of the existing mise launcher. This package
does not change host launchers, shell aliases, global defaults or authentication.

Workflow replay is deliberately opt-in. Declining replay stops that invocation. To rerun every stage, change the source (for example, add a revision comment), review it again, and approve the resulting fresh journal. Each synchronous worker evaluation is limited to 100 ms independently of the overall workflow timeout. A journal write failure stops subsequent journal writes in that invocation; rerun after correcting storage rather than retrying unjournaled effects.

External integrations never require a nested research or desktop-planning agent.
Desktop actions require a usable desktop service and its OS permissions. On macOS, install the official Codex computer-use client and ChatGPT/Codex bundled cua_node runtime; grant permissions to those apps, not the terminal. Run `/reload` after setup. Approval is explicit, never an automatic always grant; only the owned client/relay is closed, never the shared Sky service. See [setup and runtime limits](extensions/computer-use/README.md).
Linux accessibility is reported unavailable when no supported service exists.
The Linux/macOS CI matrix checks portable behavior; it does not prove a live Mac
desktop session or priority-service entitlement. Unknown power state leaves idle
sleep settings untouched. No live provider call is needed for the fixture tests.

Registered subagents share one report-only `openai-codex/gpt-5.6-luna` tracker
with medium reasoning per owning session, covering direct and workflow children.
It starts asynchronously with work, then requests at most once per minute with a
30-second deadline. After a successful report, unchanged task state skips both
the model call and report; token/cost usage changes alone do not count as progress.
Task identity, status, brief, output or error changes can trigger the next report.
Failed requests retry at the same cadence; stopping tracking resets deduplication.
Snapshots contain at most four running children, queued
counts and four recent completed children, with clipped briefs/output and usage;
no parent history is sent. Reports are capped at 2,000 characters and delivered
as bounded JSON observations marked as untrusted model-generated data, not
instructions or authority, on the next turn without waking the parent.
`subagent_status` also exposes tracker
status/errors while preserving task details. Missing model/auth never selects a
fallback. The tracker has no tools or execution authority; deterministic task
supervision remains independent. Idle, cancel-all and shutdown abort tracking;
tracker errors survive going idle. Later delegation starts tracking again.
