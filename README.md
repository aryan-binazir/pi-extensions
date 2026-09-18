# Pi extensions

Independent tools and workflows for Pi 0.85.1. Enable only what you use.

## Install

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
pi config
```

Requires access to this private Git repository. Select extensions with `pi config`,
then `/reload` or restart Pi. No build is required. Only manifest-listed entrypoints
load; helpers and tests are not extensions.

## Agent setup checklist

1. **Install and select extensions** using the commands above.
2. **Link the shared instructions.** Follow the guarded
   [symlink setup](docs/agent-setup.md#global-system-prompt-append-agent-setup) to link
   this checkout's [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) into
   `~/.pi/agent/APPEND_SYSTEM.md`. Use a stable checkout; preserve existing files.
   Package installation does **not** create the link.
3. **Install external plugins separately**, if wanted:
   - [MCP / Linear](docs/mcp-plugin-setup.md): `pi-mcp-adapter`.
   - [Bash approvals](docs/agent-setup.md#automatic-bash-permissions-external-package):
     Hank Warren's Auto Permissions. This repo's status extension is only its
     display companion, not the approval engine.
4. **Reload Pi.** Complete provider/server authentication where required.

With Subagents enabled, the system prompt includes **both** the editable selection
instructions from `APPEND_SYSTEM.md` and the effective profile catalog added by the
extension. They are separate setup steps. See [complete setup](docs/agent-setup.md).

## Extensions

| Extension | What it does |
| --- | --- |
| Questionnaire | Interactive questions through the `questionnaire` tool. |
| Todo | Session-backed task lists and stale-progress reminders. |
| Effort | `/effort` changes reasoning; `/effort new` starts a temporary model/effort session. |
| BTW | `/btw` or `/side` opens a private, tool-free side conversation. |
| Vi mode | Modal editor with motions, operators, registers, and undo. |
| Prompt stash | `Ctrl+S` stashes or swaps the main editor draft. |
| [Subagents](docs/subagents.md) | Background workers, model profiles, approved TypeScript workflows. |
| [Worktree](docs/extension-behavior.md#worktrees) | `/worktree` routes shell and relative file tools to another checkout. |
| [Computer use](extensions/computer-use/README.md) | Native desktop tools; macOS requires the official Codex service. |
| [Fast mode](docs/adr/006-search-fast-power.md) | `/fast` toggles supported base/fast model entries. |
| Auto-caffeinate | Prevents idle sleep during work on confirmed AC power. |
| Auto Permissions status | Displays the separately installed Bash-approval plugin's status. |
| [Neovim IDE](docs/adr/012-nvim-ide.md) | Connects to claudecode.nvim like Claude Code does: selection and `:ClaudeCodeSend` context, editor tools, jumps to pi edits. |

See [session/editor behavior and worktree boundaries](docs/extension-behavior.md)
for operational details. Prompt stash's shortcut applies only to the main editor;
Pi's model/thinking save bindings remain unchanged.

## Subagent configuration

**Astra medium is the bundled implementation default.** Profiles choose model and
thinking; `reader`/`writer` presets independently control tool permissions.

Overrides merge field by field:

```text
bundled defaults
  → ~/.pi/agent/subagents.json
  → trusted project's .pi/subagents.local.json (gitignored)
  → explicit spawn options
```

`PI_CODING_AGENT_DIR` overrides the global agent directory. Missing files fall back.
Reload after edits. See [profiles and override examples](docs/subagents.md#subagent-profiles).

Inspect the effective catalog from a checkout with dependencies installed:

```sh
./extensions/subagents/show-config
./extensions/subagents/show-config --cwd /path/to/project --json
```

The CLI and prompt hook share one resolver; the hook does not execute the script.
The standalone CLI includes local overrides only for projects with saved Pi trust.

## Development

```sh
npm ci
npm run check
```

`check` runs TypeScript, ESLint, and tests. Individual commands are
`npm run typecheck`, `npm run lint`, and `npm test`. CI covers Linux/macOS with
Node 22/24 using fixtures, not live provider authentication or desktop permissions.
Architecture decisions live in [docs/adr](docs/adr).

To try one extension from a checkout: `pi -e ./extensions/todo/index.ts`.
This package does not change host launchers, shell aliases, or authentication.
