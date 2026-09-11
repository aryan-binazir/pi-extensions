# Pi interactive tools

Seven independently selectable extensions for Pi 0.85.1. Install from this
private Git repository using your existing GitHub SSH access:

```sh
pi install git:git@github.com:aryan-binazir/pi-extension@amb/interactive-tools
```

After this branch lands, use the desired release or main ref. Installation uses
Pi's package manager and does not require a build. Run `/reload` in an existing
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
The stash is memory-only and clears on session start, switch and reload. Vi mode preserves raw pasted text and keeps large pastes expanded; it does not use Pi's collapsed paste markers. The exact supported vi command set is documented in [ADR 001](docs/adr/001-editor.md). Counts apply to motions, operators, doubled line operators, `x`, `p/P` and `nG/ngg`; counts on insert entry, visual toggles, text objects and undo/redo are unsupported. Registers are lowercase `a-z` and the unnamed register.

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
Subagents, worktrees, auto mode and external integrations belong to later PRs.
