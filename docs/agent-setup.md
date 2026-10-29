# Agent setup

[Back to README](../README.md)

The ordered setup checklist is in the
[README](../README.md#agent-setup-checklist). This page covers machine verification,
the shared prompt link, and separately installed external packages.

## Verify this machine's setup

Run this read-only audit once per repository session and again after setup
changes. Resolve the agent directory from `PI_CODING_AGENT_DIR`, defaulting to
`~/.pi/agent`, and use a stable checkout when checking symlinks from a worktree.

1. **Packages and selection:** use `pi list`, resource filters in `settings.json`,
   and installed manifests to verify the repository package or intended local
   extension paths exist and selected entrypoints resolve. Preserve the user's
   selection; optional features that are neither configured nor requested are
   skipped, not missing setup. Escape Continue, Regen, Guardian, Hooks, the footer
   with PR links, and Claude bridge are required;
   a missing or disabled component
   is setup drift, not a skipped optional feature.
2. **Shared instructions:** verify `APPEND_SYSTEM.md` is a readable symlink to
   this repository's tracked file in a stable checkout. With Subagents selected,
   also check its profile catalog is available; the file link alone is insufficient.
3. **Required and opted-in features:** follow the corresponding README step for
   Escape Continue, Regen, Guardian, Hooks, the footer with PR links, Claude bridge,
   and each configured or requested optional feature. For Escape Continue, compare
   selected entrypoints with [its configuration requirements](#escape-continue),
   read-only. For [Regen](#regen), verify its entrypoint is selected and its
   configured model (Luna 6 by default) resolves in the offline registry;
   no live naming request is needed for this audit.
   Check external package pins and their documented config;
   for [Guardian](#guardian), check it is selected from the footer's stable
   checkout, `bwrap --help` lists `--as-pid-1` and `--perms` on Linux, any
   `guardian/config.json` parses and keeps the required reviewer, and the retired
   Auto Permissions package is not installed;
   for Hooks, check its selected entrypoint is in a stable checkout, and that no
   Guard entry or `guard.json` link remains;
   for the footer, check the footer extension selection and `gh` on `PATH`,
   reporting a failing `gh auth status --active --hostname github.com` as
   unverified sign-in rather than drift. For Claude
   bridge, use the offline model-list command below, check `provider.plan` is
   `"max"`, and preserve the separate `AskClaude` opt-in.
4. **Thinking and scoped models:** verify [default thinking](#default-thinking),
   then verify every model required by [AGENTS.md](../AGENTS.md)
   is included in the saved scope and resolves in the offline model list. Follow
   [scoped model setup](#required-scoped-models); report missing models as drift.
5. **MCP and runtime limits:** verify selected MCP support uses Pi's built-in
   extension and keep server configuration user-scoped. Treat disk configuration
   and loaded-session state separately: require `/reload` after changes, and mark
   sign-in, live provider requests, permission enforcement, and MCP connectivity
   as unverified unless already observed. Configuration checks establish neither
   credentials nor successful execution.

Keep the audit read-only: inspect only setup-relevant configuration, leave
credentials untouched, and avoid installation, sign-in, model requests, or MCP
connections. Completion is a brief report of verified steps, skipped optional
steps, and drift or unverified items, naming the relevant file and README step.
Ask Ar before repairs or changes to personal settings; continue unrelated work
when a setup issue does not block it. Keep machine-specific audit results out of
tracked instructions.

## Background model defaults

Optionally enable this repository's Background models extension with `pi config`. For a
local checkout, select the stable checkout's absolute
`extensions/background-models/index.ts` path in user-scoped `settings.json`.
Preserve unrelated extension selections.

It defaults extension registry `stream`/`complete` requests for `gpt-6-luna`
to medium reasoning, preserving explicit effort. It also omits `temperature`
from Codex requests because that endpoint rejects the parameter. The main session
uses its own model runtime and thinking settings.

Keep Background models after Hooks in `settings.json.extensions`. User-local
extension paths load before packages. When using packages, put this repository
before packages that make background requests in `settings.json.packages` so
defaults apply from startup.

Completion: verify the selection and startup order, then restart Pi. Verify
background request effort separately from the main-session footer. Calls through
`streamSimple` or a provider's own runtime retain their existing settings.

## Escape Continue

Install this repository package using the [README install commands](../README.md#install)
and enable `escape-continue` with `pi config`. For a local installation, add the
stable checkout's absolute `extensions/escape-continue/index.ts` path to
`extensions` in user-scoped `settings.json`. Preserve unrelated selections and
obtain Ar's approval before changing personal settings.

Completion: the entrypoint exists and is selected, then ask Ar to run `/reload`.
Selection is a disk check, not evidence of loaded behavior. In the TUI, Escape
with a queued message should stop the current run and start that message; Escape
with no queued message should stop. See
[behavior and compatibility limits](extension-behavior.md#escape-continue).
Ctrl+Enter invokes the same interrupt action while retaining Vi insert mode.
The terminal must report Ctrl+Enter separately from Enter through Kitty keyboard
protocol or xterm modifyOtherKeys.

## Regen

Install this repository package using the [README install commands](../README.md#install)
and enable `regen` with `pi config`. If the package is already installed, update it
with `pi update git:git@github.com:aryan-binazir/pi-extensions@main` first. For a
local checkout installation, select the stable checkout's absolute
`extensions/regen/index.ts` path in user-scoped `settings.json`. Keep other
extension selections and avoid loading a second copy from another checkout.
Obtain Ar's approval before changing personal settings.

Regen names fresh threads automatically after their first user message and
exposes `/regen-name` for manual regeneration. It defaults to
`openai-codex/gpt-6-luna` with low reasoning; optional trusted project
`.pi/regen.json` overrides are described in [Regen](regen.md#project-local-configuration).
The naming model must be registered and authenticated, but its scoped-model
selection is independent of Regen.

Completion: `extensions/regen/index.ts` exists and is selected, and the configured
model resolves in the offline model list. Ask Ar to run `/reload`. Disk selection
and model registration do not prove live naming behavior or provider sign-in.

## Default thinking

Set `"defaultThinkingLevel": "high"` in user-scoped `settings.json` under the
resolved agent directory. Preserve the startup provider/model, explicit per-model
thinking overrides, and unrelated settings. Report a missing or different value
as drift during the read-only audit; obtain Ar's approval before editing.

Completion: the saved local default is `high`. Ask Ar to run `/reload` after
changes; this startup default does not change the current session's effort or
subagent profile thinking.

## Required scoped models

During setup, include all three model IDs required by [AGENTS.md](../AGENTS.md)
in the saved `/scoped-models` selection (`enabledModels` in user-scoped
`settings.json`). Resolve them through this machine's existing model connections;
keep existing qualified entries, additional selected models, and startup defaults.
Add missing entries only after setup changes are approved. If a required model
is unavailable or its connection is ambiguous, report the blocker and ask Ar
rather than substituting another model or changing connections.

Completion: all three required IDs are selected and resolve in
`pi --offline --no-mcp --list-models`. Ask Ar to run `/reload` after settings edits.
The offline list verifies registration, not live authentication or execution.
This scope controls model selection and cycling; it does not rewrite subagent
profiles or the background tracker's model.

## Global system-prompt append (agent setup)

[`APPEND_SYSTEM.md`](../APPEND_SYSTEM.md) is the version-controlled source for shared
cross-project instructions, including editable subagent selection guidance.
Keep repository rules in `AGENTS.md`. Pi appends this file to its default system
prompt rather than replacing it.

With Subagents enabled, the symlinked file and the extension's generated profile
catalog are two separate pieces, and neither substitutes for the other; see
[Subagent profiles](subagents.md#subagent-profiles).

Agents setting up this repository must link this file into Pi's global agent
directory. Run the following from a **stable checkout** of this repository, not a
temporary worktree (the checkout must remain available):

```sh
(
  set -eu
  source_file="$(pwd -P)/APPEND_SYSTEM.md"
  agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  target="$agent_dir/APPEND_SYSTEM.md"
  test -f "$source_file"
  mkdir -p "$agent_dir"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source_file" ]; then
    printf 'Already linked: %s\n' "$target"
  elif [ -e "$target" ] || [ -L "$target" ]; then
    printf 'Existing append file/link: %s. Preserve it and ask before replacing or merging.\n' "$target" >&2
    exit 1
  else
    ln -s "$source_file" "$target"
  fi
  test -f "$target"
  test "$(readlink "$target")" = "$source_file"
)
```

The default target is `~/.pi/agent/APPEND_SYSTEM.md`; `PI_CODING_AGENT_DIR`
overrides that directory. Preserve existing files and symlinks, including broken
links; obtain approval before merging or replacing them. Never use a force-link
command to discard existing instructions. Verify the link as above, then run
`/reload` in Pi or restart it. Edit the repository source, not a separate copy;
future source updates are picked up on reload. If the checkout moves, update the
link. This is an explicit local setup step, not an automatic install hook.

## Guardian

[Guardian](guardian.md) is the required approval engine. By default it reviews commands and
file changes, then runs approved actions on the host with Pi's environment and credentials. Select it with `pi config`, or add the absolute path to
`extensions/guardian/index.ts` in a **stable checkout** to `extensions` in
`~/.pi/agent/settings.json`, preserving other entries. Use the same checkout as
the [footer](#footer), which shows Guardian's status only for its own checkout.

On Linux, install bubblewrap 0.8 or newer (`sudo pacman -S bubblewrap` on Arch,
`sudo apt install bubblewrap` on Ubuntu 24.04 and later); see
[Guardian on Linux](guardian.md#linux). Bubblewrap supports the reviewer's read-only inspections and optional sandbox modes. Host execution works without it, but reviewer inspections do not.

**Reviewer.** The required reviewer is `openai-codex` / `gpt-6-luna~fast` at
`low` reasoning, which is Guardian's default and uses the existing Codex
connection. A missing `~/.pi/agent/guardian/config.json` (under
`$PI_CODING_AGENT_DIR` when set) means the defaults. When the file exists, its
`reviewer` must be absent or exactly
`{"provider": "openai-codex", "model": "gpt-6-luna~fast", "reasoning": "low"}`;
preserve its other settings, which are personal. Fast mode registers the `~fast`
alias; without it, Guardian falls back to plain `gpt-6-luna`.

**Shared policy.** Guardian loads `personal-settings/guardian/extra-policy.md`
and `personal-settings/guardian/rules/*.rules` from its own checkout, so no link
or copy is needed. Change shared policy there; personal additions belong in the
[preferences](guardian.md#preferences) and `~/.pi/agent/guardian/rules/`.

**Retired package.** Guardian replaces Hank Warren's Auto Permissions. Where
`npm:@hank-warren/pi-auto-permissions` is still in `settings.json` `packages`,
ask Ar, then run `pi remove npm:@hank-warren/pi-auto-permissions`. While both
load, commands are reviewed twice and Guardian warns at session start.

Completion: Guardian is selected from the footer's stable checkout, bubblewrap is
usable on Linux, the reviewer is the required one, no other approval package is
installed, and Ar has run `/reload`. Check `/guardian status` for the reviewer sandbox. The footer
shows `Auto: on · Luna low · host` with the default execution mode.

## Footer

This repository's footer extension (code in `extensions/footer/`) is required.
Its entry point is still `extensions/auto-permissions-status/index.ts`, kept so
existing setups need no change. Enable it with `pi config`; for a local checkout,
add the absolute path to `extensions/auto-permissions-status/index.ts` to
`extensions` in `~/.pi/agent/settings.json`.

It replaces Pi's footer. The first row shows the directory, branch, pull request
link and session name, with [Guardian's status](guardian.md#commands-and-status)
on the right; the second shows token/cache/cost/context usage, with the main model
on the right; a third row shows other extensions' statuses. `Auto: unavailable`
means Guardian is not loaded from the footer's checkout, and `Auto: config error`
means its `config.json` is invalid. **Pi has one footer slot**, so do not run it
alongside another custom-footer extension. It restores the default footer on
shutdown.

The pull request link is a clickable link to the branch's GitHub pull request
after the branch name. Do not also install a PR-status or footer package; they compete for
the one footer slot or have their links stripped.

The link needs the [GitHub CLI](https://cli.github.com/) on `PATH`, signed in to
the repository's host. Install `gh` with the machine's package manager (for
example `pacman -S github-cli` or `brew install gh`), then ask Ar to run
`gh auth login`; agents must not sign in or handle tokens. Verify:

```sh
gh --version
gh auth status --active --hostname github.com
```

The status check contacts GitHub; during the read-only audit a failure means
sign-in is unverified, not missing setup.

After `/reload`, a branch with a pull request shows its number after the branch:
`~/repo (branch) #42 • Session`. Open PRs show only the number; draft, merged
and closed PRs add that word. Where Pi detects hyperlink support the number is
an OSC 8 link, so Ctrl-click (Cmd-click on macOS) opens the PR; elsewhere it is
plain text. Inside tmux, also set `set -as terminal-features ',*:hyperlinks'`.

The extension runs
`gh pr view --json number,url,state,isDraft,headRefName -- <branch>` in the
session directory whenever the footer's branch or directory changes, after each
agent turn, and after agent Bash calls that use `git` or `gh`; it does not poll.
Commands Ar runs with `!` or `!!` update the link after the next turn or branch
change. Without a PR, `gh`, sign-in or network, the footer shows no link and no
error. gh searches the repository it resolves as the base (it prefers an
`upstream` remote) for a PR whose head branch has the local branch's name; PRs
in other repositories, and local branches tracking a differently named remote
branch, show no link. The link follows Pi's branch for the session directory.

Completion: `extensions/auto-permissions-status/index.ts` is selected and
`gh auth status --active --hostname github.com` reports a signed-in account. Ask Ar to run `/reload`; a branch with an open PR then
shows its number in the footer.

## Claude bridge (external package)

Installing [Eli Dickinson's pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)
is required for this setup. Install it separately from this repository. Only the
`AskClaude` delegation tool is optional. The bridge uses Anthropic's Claude Agent SDK to run
Claude Code as a Pi model provider. The reviewed release is pinned:

```sh
pi install npm:pi-claude-bridge@0.9.2
```

This adds the package to `~/.pi/agent/settings.json` (or under
`PI_CODING_AGENT_DIR`), preserving existing packages and the default model. It is
not bundled with this repository. Review a new release before changing the pin.
See the [source verification](research/pi-claude-bridge-sdk.md) for the SDK trace
and verification limits; SDK use alone does not establish subscription billing
or Anthropic approval.

Verify installation and provider registration without making a model request:

```sh
pi list
pi --offline --no-mcp --list-models claude-bridge
```

Set the required Max plan by merging this into `~/.pi/agent/claude-bridge.json`
(or under `PI_CODING_AGENT_DIR`), preserving existing settings such as
`startupNoticeShown`:

```json
{
  "provider": {
    "plan": "max"
  }
}
```

This advertises Max-plan context limits; it does not authenticate or upgrade a plan.

Completion: `pi list` includes `npm:pi-claude-bridge@0.9.2`, the model list
includes the `claude-bridge` provider, and `provider.plan` is `"max"`. Ask the user to run `/reload`, then use
`/model` to select a `claude-bridge/*` model. The bridge uses Claude Code's
credentials and environment; complete any required sign-in in Claude Code,
keeping credentials outside this repository. Exported `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_BASE_URL` can override that authentication
or endpoint; see upstream's configuration and known issues before changing them.

### Optional AskClaude delegation

The provider is enabled by installation; `AskClaude` remains off by default.
Enable it only when requested. Merge these settings into
`~/.pi/agent/claude-bridge.json` (or under `PI_CODING_AGENT_DIR`), preserving any
existing settings:

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": false
  }
}
```

After `/reload`, `AskClaude` is available when using a different provider. Its
default mode is read-only. It uses Claude Code's native tools rather than Pi's
tool approvals; keep full read/write/bash mode disabled unless explicitly
requested.
