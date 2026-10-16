# Pi extensions

Independent tools and workflows for Pi. Development checks use the Pi 0.99.1 SDK
packages pinned in `package.json`. [Subagent connector delegation](docs/subagents.md#connector-delegation)
requires Pi 0.99.1 or newer. [Escape Continue](docs/extension-behavior.md#escape-continue)
also has TUI verification on Pi 0.87.1, 1.0.2 and 1.2.0. Enable only what you use.

## Install

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
pi config
```

Requires access to this private Git repository. Select extensions with `pi config`,
then `/reload` or restart Pi. No build is required. Only manifest-listed entrypoints
load; helpers and tests are not extensions.

## Agent setup checklist

1. **Install and select extensions** using the commands above. Enable
   [Escape Continue (required)](docs/agent-setup.md#escape-continue).
2. **Link the shared instructions.** Follow the guarded
   [symlink setup](docs/agent-setup.md#global-system-prompt-append-agent-setup) to link
   this checkout's [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) into
   `~/.pi/agent/APPEND_SYSTEM.md`. Use a stable checkout; preserve existing files.
   Package installation does **not** create the link.
3. **Install Bash approvals separately (required).** Follow
   [Automatic Bash permissions](docs/agent-setup.md#automatic-bash-permissions-external-package)
   to configure Hank Warren's Auto Permissions with `gpt-6-luna`
   at low reasoning. This repo's footer only displays its status; it is not the
   approval engine.
4. **Enable Hooks (required).** Follow [Hooks setup](#hooks) to select the
   extension, load it before Auto Permissions, and remove Guard where it is still
   installed.
5. **Enable the footer (required).** Select this repo's footer extension (its
   entry point is still `extensions/auto-permissions-status/index.ts`) and install
   the GitHub CLI signed in to GitHub; see [footer setup](docs/agent-setup.md#footer).
6. **Install Claude bridge separately (required).** Follow
   [Claude bridge setup](docs/agent-setup.md#claude-bridge-external-package) for the
   pinned Agent SDK provider and its required Max plan setting. Only the `AskClaude`
   delegation tool is optional.
7. **Configure the required scoped models.** Follow
   [scoped model setup](docs/agent-setup.md#required-scoped-models), preserving this
   machine's existing model connections.
8. **Install memory and autocomplete separately (required).** Follow
   [background model defaults](docs/agent-setup.md#background-model-defaults),
   [OMMS setup](docs/agent-setup.md#omms-memory-external-package) and
   [Ghost Autocomplete setup](docs/agent-setup.md#ghost-autocomplete-external-package).
   Enable old-history import for OMMS. Vi mode composes with Ghost's editor.
9. **Reload Pi.** Complete provider authentication where required. Pi manages MCP
   servers through its built-in MCP support and `~/.pi/agent/mcp.json`.

With Subagents enabled, the system prompt includes **both** the editable selection
instructions from `APPEND_SYSTEM.md` and the effective profile catalog added by the
extension. They are separate setup steps. See [complete setup](docs/agent-setup.md).

## Extensions

| Extension | What it does |
| --- | --- |
| [Hooks](#hooks) | Tested block, advise and gate hooks, switched on in `personal-settings/hooks.yaml`. Replaces Guard. |
| [Background models](docs/agent-setup.md#background-model-defaults) | Defaults extension Luna calls to low reasoning and omits unsupported Codex temperature. |
| Questionnaire | Interactive questions through the `questionnaire` tool. |
| Todo | Compact task summary; `alt+t` toggles the full list. Session-backed progress and stale-progress reminders. |
| Effort | `/effort` changes reasoning; `/effort new` starts a temporary model/effort session. |
| BTW | `/btw` or `/side` opens a private, tool-free side conversation. |
| Vi mode | Modal editor with motions, operators, registers, and undo. |
| Prompt stash | `Ctrl+S` stashes or swaps the main editor draft. |
| [Escape Continue](docs/extension-behavior.md#escape-continue) | Escape or Ctrl-X, Ctrl-S stops the active run and starts the next queued user message; no queued message means stop. The chord preserves Vi insert mode. |
| [Subagents](docs/subagents.md) | Background workers, model profiles, approved TypeScript workflows; `alt+r` toggles the compact/full panel. |
| [Computer use](extensions/computer-use/README.md) | Native desktop tools; macOS requires the official Codex service. |
| [Fast mode](docs/adr/006-search-fast-power.md) | `/fast` toggles supported base/fast model entries. |
| Auto-caffeinate | Prevents idle sleep during work on confirmed AC power. |
| [Footer](docs/agent-setup.md#footer) | Replaces Pi's footer: directory, branch and clickable GitHub PR link, session, token/cost/context usage, model, Auto Permissions status, and other extensions' statuses. |
| [Neovim IDE](docs/nvim-ide.md) | Connects to claudecode.nvim: bounded request snapshots, reliable editor sends, editor tools, and coalesced live follow with reconnect replay. |

See [session and editor behavior](docs/extension-behavior.md)
for operational details. Prompt stash's shortcut applies only to the main editor;
Pi's model/thinking save bindings remain unchanged.

## Hooks

Hooks are required for this setup. Each hook is tested TypeScript in
[`extensions/hooks/catalog`](extensions/hooks/catalog);
[`personal-settings/hooks.yaml`](personal-settings/hooks.yaml) only switches hooks
on or off, and hooks it does not list are off. The extension reads that file from
its own checkout on every event, so switches need no `/reload`, and other machines
pick them up with `git pull` (local path) or `pi update` (package). Hooks added by
newer code load after `/reload`; until then their switches only produce a notice. The file is
public: keep private information out of it. Design: [ADR 014](docs/adr/014-hooks.md).

| Type | Runs | Effect |
| --- | --- | --- |
| Block | Before a tool call | Stops the call and gives the model the reason. |
| Advise | After a tool call | Appends a note to the result the model sees. |
| Gate | When the agent is about to finish | Sends it back to work with the reason, at most three times per prompt. |

- `draft-prs` (block): requires an effective `--draft` or `-d` on `gh pr create`
  (including `gh pr new`). `--draft=false` is not a draft, and `--dry-run` receives
  the same check. `--web`/`-w` is blocked with instructions to drop it and pass
  `--draft`, because gh cannot create drafts with `--web`. `gh pr ready` remains allowed.
- `no-admin-merge` (block): rejects an effective `--admin` on `gh pr merge` and
  tells the agent to satisfy normal review and check requirements. `--admin=false`
  is allowed.
- `rg-replace-flag` (advise): after `rg -r` or `rg --replace`, notes that `-r`
  means `--replace` in rg, not recursive.

Hooks run before Auto Permissions: a blocked call never reaches its reviewer, and
calls that hooks allow are still reviewed. Subagents load hooks before any other
child extension and do not start without them.

**Protection.** Agents can switch hooks on but never off. They change any
`personal-settings/hooks.yaml`, in every checkout and through symlinks, only by
writing the whole file, allowed when every enabled hook stays enabled and the live
file names only existing hooks. Edits are refused because they apply to whatever
the file holds when they run. Bash may only read, diff, add and commit it.
Only the user switches hooks off, removes them, or repairs an invalid file. A
missing or invalid live file blocks every tool except `read`, `grep`, `find`, `ls`
and `questionnaire` until the user fixes it.

**Setup.** From a **stable checkout** (not a temporary worktree):

1. Select Hooks with `pi config`, or add the checkout's `extensions/hooks/index.ts`
   to `extensions` in your Pi settings. Preserve other entries.
2. Load Hooks before Auto Permissions. Pi loads `extensions` entries before
   `packages`, so a local path already does; with the Git package, list it before
   `npm:@hank-warren/pi-auto-permissions` in `packages`.
3. Remove Guard where it is still installed: delete the `extensions/guard/index.ts`
   entry from Pi settings and the `guard.json` link in the agent directory
   (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). If `guard.json` is a regular
   file rather than a link, back it up and ask the user before removing it.

Completion: Hooks is selected and loads before Auto Permissions, no Guard entry or
`guard.json` remains, and the user has run `/reload`.

**Scope is a workflow guardrail, not a sandbox.** Bash hooks recognize literal
simple commands, absolute command paths, leading environment assignments, quoting
(including `$'...'` and `$"..."`), comments, and simple `;`, `&&`, `||`,
pipe/newline chains. The `gh` hooks distinguish flags from title/body values,
repository selection, short clusters and repeated boolean flags, and allow help
requests; `gh` commands using numeric, Unicode, control, or unknown `$'...'`
escapes are blocked rather than decoded. Hooks do not interpret shell expansion,
substitutions (including `url=$(gh pr create ...)`), heredocs, functions, aliases,
redirections, scripts, grouping (`(...)`, `{ ...; }`), control flow (`if`, loops),
`!`, `time`, or wrappers such as `command`, `env`, and `bash -c`. Complex shell can
evade checks or be misclassified; use direct simple invocations for predictable
results. `gh api`, MCP/API calls and user `!`/`!!` commands are not covered.

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
