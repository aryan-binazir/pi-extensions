# Pi interactive tools

Thirteen independently selectable extensions for Pi 0.85.1. Install from this
private Git repository using your existing GitHub SSH access:

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
```

Installation uses Pi's package manager and does not require a build. Run `/reload` in an existing
Pi session, then use `pi config` to select extensions. The manifest lists only each feature's `index.ts`; helper and test
files are never entrypoints. `Ctrl+Shift+S` requires a terminal supporting an enhanced keyboard protocol such as Kitty; legacy terminals cannot distinguish it from `Ctrl+S`. The extension does not remap `Ctrl+S`.

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
| Prompt stash | `Ctrl+Shift+S` | Stash, restore or swap one draft slot; a footer indicator shows occupancy. |
| Subagents | `subagent`, TypeScript workflows | Isolated task contexts, bounded background execution and approved workflow replay. |
| Worktree | `/worktree` | Create or reuse a checkout and route the current session's shell and relative file tools. |
| Harbor MCP | MCP tools, resources, templates and prompts; `/mcp` status | TypeScript client with bounded discovery, per-server deadlines and explicit consent. [Setup and limits](extensions/mcp-client/README.md). |
| Computer use | Desktop tools | Pi directs screenshots and input through native Linux or macOS adapters. See [desktop setup](extensions/computer-use/README.md). |
| Fast mode | `/fast` | Toggle supported base/fast model entries while retaining provider authentication and reasoning. [Provider support](docs/adr/006-search-fast-power.md). |
| Auto-caffeinate | Agent lifecycle | Temporarily inhibit idle sleep during work on confirmed AC power, including background tasks. |

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
process groups, including ordinary descendants. A descendant that deliberately
creates a new session can escape portable process-group cleanup.

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
There is no global tool classifier or mandatory child guard. These launch-time
checks do not sandbox child tools or trusted extension JavaScript.

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
Desktop actions require a usable native desktop service and its OS permissions.
Linux accessibility is reported unavailable when no supported service exists.
The Linux/macOS CI matrix checks portable behavior; it does not prove a live Mac
desktop session or priority-service entitlement. Unknown power state leaves idle
sleep settings untouched. No live provider call is needed for the fixture tests.
