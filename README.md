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
4. **Set up Guard**, if wanted: follow [Guard setup](#guard-setup-for-agents) to
   link the tracked rules file directly. Installation alone
   does not enable the rules.
5. **Reload Pi.** Complete provider/server authentication where required.

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
| [Guard](#guard-setup-for-agents) | Blocks non-draft PR creation and administrator merges in recognizable Bash `gh` calls. |
| Auto Permissions status | Displays the separately installed Bash-approval plugin's status. |
| [Neovim IDE](docs/adr/012-nvim-ide.md) | Connects to claudecode.nvim like Claude Code does: selection and `:ClaudeCodeSend` context, editor tools, jumps to pi edits. |

See [session/editor behavior and worktree boundaries](docs/extension-behavior.md)
for operational details. Prompt stash's shortcut applies only to the main editor;
Pi's model/thinking save bindings remain unchanged.

## Guard setup for agents

Enable Guard with `pi config`, or add the stable checkout's
`extensions/guard/index.ts` to `extensions` in your Pi settings. Preserve other
entries. Guard reads `$PI_CODING_AGENT_DIR/guard.json` (default
`~/.pi/agent/guard.json`) before each Bash call; `/reload` is needed to load the
extension, not to edit its rules.

From a **stable checkout** (not a temporary worktree), run this Bash setup after
reviewing [`extensions/guard/guard.json`](extensions/guard/guard.json):

```bash
(
  set -eu
  repo=$(git rev-parse --show-toplevel)
  rules="$repo/extensions/guard/guard.json"
  agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  case "$agent_dir" in
    '~') agent_dir="$HOME" ;;
    '~/'*) agent_dir="$HOME/${agent_dir#\~/}" ;;
  esac
  target="$agent_dir/guard.json"
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf 'Preserving existing config: %s — inspect before changing it.\n' "$target"
    exit 1
  fi
  test -f "$rules"
  mkdir -p "$agent_dir"
  ln -s "$rules" "$target"
  ls -l "$target"
)
```

Completion: verify the link targets this checkout's tracked
`extensions/guard/guard.json`, enable the extension, and ask the user to run
`/reload`. If a config already exists, inspect it and agree on changes with the
user; back it up before editing. Edit the tracked file to change the rules;
changes through the symlink also modify that file. Setup is manual: the package
never links configuration automatically.

Both sample booleans are required; set either to `false` to disable that rule:

- `requireDraftPr`: require an effective `--draft` or `-d` on `gh pr create`
  (including `gh pr new`). `--draft=false` is not a draft. `--dry-run` receives
  the same check. `--web`/`-w` is blocked with instructions to drop it and pass
  `--draft`: gh cannot create drafts with `--web`. `gh pr ready` remains allowed.
- `blockAdminMerge`: reject an effective `--admin` on `gh pr merge`; instruct the
  agent to satisfy normal review/check requirements. `--admin=false` is allowed.

Missing config means inactive. Invalid/unreadable config or a broken config
symlink blocks Bash with a
repair message; other tools remain available to fix it. No model or approval
popup is involved. A blocked Bash call is stopped in full before any of it runs.

**Scope is a workflow guardrail, not a sandbox.** It recognizes literal simple
`gh` commands, absolute paths to `gh`, leading environment assignments, repository
selection, quoting, comments, and simple `;`, `&&`, `||`, pipe/newline chains.
It distinguishes flags from title/body values and understands short clusters and
repeated boolean flags. Help requests are allowed. It does not interpret shell
expansion, substitutions (including `url=$(gh pr create ...)`), heredocs,
functions, aliases, redirections, scripts, grouping (`(...)`, `{ ...; }`),
control flow (`if`, loops), `!`, `time`, or wrappers such as `command`, `env`, and
`bash -c`. Complex shell can evade checks or be misclassified;
use direct simple invocations for predictable results. `gh api`, MCP/API calls,
user `!`/`!!` commands and subagent sessions without Guard loaded are not covered.
This does not extend the separate Bash Auto Permissions reviewer to MCP.

## Subagent configuration

Profiles choose model and thinking; `reader`/`writer` presets independently
control tool permissions. Selection guidance — which profile to reach for, and
the bundled default — lives in [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md).

Overrides merge field by field:

```text
bundled defaults
  → ~/.pi/agent/subagents.json
  → trusted project's .pi/subagents.local.json (gitignored)
  → explicit spawn options
```

`PI_CODING_AGENT_DIR` overrides the global agent directory. Missing files fall back.
Reload after edits. See [profiles, override examples and the `show-config`
CLI](docs/subagents.md#subagent-profiles).

## Development

```sh
npm ci
npm run check
```

`check` runs TypeScript, ESLint, and tests. Individual commands are
`npm run typecheck`, `npm run lint`, and `npm test`. Verification is local; this
repository has no CI. Architecture decisions live in [docs/adr](docs/adr).

To try one extension from a checkout: `pi -e ./extensions/todo/index.ts`.
This package does not change host launchers, shell aliases, or authentication.
