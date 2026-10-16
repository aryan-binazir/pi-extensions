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
   skipped, not missing setup. Escape Continue, Bash approvals, Hooks, the footer
   with PR links, Claude bridge, background model defaults, OMMS, and Ghost Autocomplete are required;
   a missing or disabled component
   is setup drift, not a skipped optional feature.
2. **Shared instructions:** verify `APPEND_SYSTEM.md` is a readable symlink to
   this repository's tracked file in a stable checkout. With Subagents selected,
   also check its profile catalog is available; the file link alone is insufficient.
3. **Required and opted-in features:** follow the corresponding README step for
   Escape Continue, Bash approvals, Hooks, the footer with PR links, Claude bridge,
   [OMMS](#omms-memory-external-package), [Ghost Autocomplete](#ghost-autocomplete-external-package),
   and each configured or requested optional feature. For Escape Continue, compare
   selected entrypoints with [its configuration requirements](#escape-continue),
   read-only. Check external package pins and their documented config;
   for Bash approvals, check the reviewer settings;
   for Hooks, check its selected entrypoint is in a stable checkout and loads before
   Auto Permissions, and that no Guard entry or `guard.json` link remains;
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

Enable this repository's Background models extension with `pi config`. For a
local checkout, select the stable checkout's absolute
`extensions/background-models/index.ts` path in user-scoped `settings.json`.
Preserve unrelated extension selections.

It defaults extension requests for `gpt-6-luna` to low reasoning, preserving any
explicit effort. It also omits `temperature` from extension Codex requests,
because that endpoint rejects the parameter sent by Ghost. The main session uses
its own model runtime and thinking settings.

Completion: the extension is selected and loads before an OMMS or Ghost request.
Restart Pi after changing selection. Verify background request effort separately
from the main-session footer.

## OMMS memory (external package)

Install [om-memory-system](https://pi.dev/packages/om-memory-system) separately
from this repository. The reviewed package version is pinned:

```sh
pi install npm:om-memory-system@4.18.0
```

Before starting a session with the extension enabled, merge its configuration
into `~/.config/omms/omms.jsonc`, preserving existing settings. This path is
independent of `PI_CODING_AGENT_DIR`. Use this machine's existing Pi connection
for `gpt-6-luna` as `MODEL_CONNECTION`.

The default background model is GPT-6 Luna at **low** reasoning. Enable
[background model defaults](#background-model-defaults) to apply that effort.

```json
{
  "piProvider": "MODEL_CONNECTION",
  "piModel": "gpt-6-luna",
  "piBackfillModel": "MODEL_CONNECTION/gpt-6-luna",
  "autoBackfill": true,
  "autoCaptureEnabled": true,
  "webServerAutoStart": false,
  "webServerHost": "127.0.0.1"
}
```

Ar has approved importing old session history as part of this setup. Keep
`autoBackfill` enabled. Import, capture, and profile learning send conversation
content to the selected model and make additional model calls. Keep credentials
in Pi's existing connection.

Memories default to `~/.omms/data`. Embeddings run locally and download their
model on first use. The web app binds to localhost at port 4747; the configuration
above leaves login autostart off. Preserve existing storage and embedding choices.
If npm reports blocked dependency install scripts, verify the local embedding
backend before approving only the scripts it needs.

Completion: `pi list` includes the pin, its extension and memory skill are
selected, the configured model resolves in the offline model list, and the saved
`autoBackfill` is `true`. Restart Pi, verify the `memory` tool
is available, and test capture and recall with a disposable note. Report model
calls, embeddings, and recall as unverified until observed.

## Ghost Autocomplete (external package)

Install [pi-ghost-autocomplete](https://pi.dev/packages/pi-ghost-autocomplete)
separately from this repository. The reviewed package version is pinned:

```sh
pi install npm:pi-ghost-autocomplete@0.17.0
```

Use an existing Pi model connection instead of the default Mercury provider,
which requires a separate Inception API key. Persist these exports in the shell
startup file or Pi launcher that this machine actually uses, replacing
`MODEL_CONNECTION` with its existing connection for `gpt-6-luna`.

Use GPT-6 Luna at **low** reasoning by default. Enable
[background model defaults](#background-model-defaults) to apply that effort and
omit the Codex-incompatible temperature parameter.

```sh
export PI_GHOST_PROVIDER=pi
export PI_GHOST_MODEL=MODEL_CONNECTION/gpt-6-luna
```

Preserve existing Ghost settings and unrelated launcher behavior. Restart the Pi
process after changing its environment; `/reload` cannot import new exports from
the parent shell. Ghost makes additional model calls with draft text and recent
conversation context. Keep raw-prompt evaluation capture and debug logging off
unless requested.

Enable both Ghost and this repository's Vi mode. Vi attaches to the active
editor after session startup, so Ghost keeps its provider, commands, and
lifecycle in either load order. Suggestions are available in insert mode;
Escape clears the suggestion and enters normal mode. Vi motions, visual
selection, undo, paste payloads, prompt stash, and Escape Continue remain
available. Keep this repository updated on machines using both extensions.

Run the real-package regression tests against the globally installed pin:

```sh
PI_GHOST_TEST_ENTRYPOINT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-ghost-autocomplete/dist/index.js" npm run check
```

The package requires a native binary for the host platform and has no JavaScript
fallback. Some compiled Pi runtimes cannot resolve the optional platform package
by name even when its binary loads by absolute path. In that case, use Ghost's
existing file fallback: symlink the matching platform package's `.node` file into
`pi-ghost-autocomplete/dist/` with the same filename. Preserve any existing target,
verify matching package versions, and recheck after package upgrades.

Completion: the pinned package and matching platform dependency are
installed, both extensions are selected, and `/ghost` reports the
intended Pi provider/model after restart. In the TUI, type a draft, observe a
suggestion, accept it with Right Arrow or Tab, and verify the retained editor
shortcuts. Installation and model registration alone do not verify suggestions.

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
Ctrl-X, Ctrl-S invokes the same interrupt action while retaining Vi insert
mode. It needs no additional keybinding setup.

## Default thinking

Set `"defaultThinkingLevel": "medium"` in user-scoped `settings.json` under the
resolved agent directory. Preserve the startup provider/model, explicit per-model
thinking overrides, and unrelated settings. Report a missing or different value
as drift during the read-only audit; obtain Ar's approval before editing.

Completion: the saved local default is `medium`. Ask Ar to run `/reload` after
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

## Automatic Bash permissions (external package)

This setup requires [Hank Warren's Auto Permissions](https://www.npmjs.com/package/@hank-warren/pi-auto-permissions)
installed and enabled with the reviewer configuration below. Install it separately
from this repository, pinned:

```sh
pi install npm:@hank-warren/pi-auto-permissions@0.21.0
```

**Required version: 0.21.0.** During the read-only audit, compare both the
configured package pin (`pi list` / `settings.json`) and the installed package's
`package.json` version. After the audit, if either differs, back up settings and
policy, run the pinned install command above, and follow the upgrade procedure
below. This specific version repair is preapproved; preserve unrelated settings
and policy exceptions. A general extensions update does not advance a pinned
version. Completion requires both versions to be 0.21.0, the compatible footer
adapter to be installed, config validation to pass, and the user to run `/reload`.

Pi adds `"npm:@hank-warren/pi-auto-permissions@0.21.0"` to the `packages` array in
`~/.pi/agent/settings.json`, preserving existing extensions. The pin does not
update itself; review new versions before upgrading. Do not also load the
upstream `@ogulcancelik/pi-auto-permissions`: overlapping guards cause duplicate
reviews. Create `~/.pi/agent/pi-auto-permissions/config.json` (or under your
`PI_CODING_AGENT_DIR`). In the template below, replace `MODEL_CONNECTION` with
this machine's existing connection identifier for `gpt-6-luna`; preserve the
current `reviewer.provider` when it resolves that model. If the connection is
missing or ambiguous, ask Ar before writing the config.

```json
{
  "enabled": true,
  "reviewAllShell": true,
  "rules": ["$defaults"],
  "reviewConcurrency": 1,
  "reviewer": {
    "provider": "MODEL_CONNECTION",
    "model": "gpt-6-luna",
    "reasoningEffort": "low",
    "timeoutMs": 60000
  },
  "guardianPolicy": {
    "environment": [],
    "allow": [],
    "softDeny": [],
    "hardDeny": []
  }
}
```

Review is then on by default across sessions: every Bash command goes through the
rules and, absent a hard deny, trusted-group bypass or session approval, Luna review
at low reasoning. Complete any required sign-in for the existing model connection
and make sure `gpt-6-luna` is available; the main agent can use a different model.
`reviewConcurrency: 1` preserves serial reviews; the package default is four.
The prefilter was removed in 0.17.0, so every reviewed command gets full review.
`guardianPolicy` takes natural-language preferences: trusted
infrastructure in `environment`, scoped exceptions in `allow`, restrictions
needing explicit authorization in `softDeny`, unconditional ones in `hardDeny`.
They supplement the built-in policy and never override deterministic hard denies.
**Coverage is Bash only, not an OS sandbox:** edits, writes, MCP and desktop tools
are not gated, this repository's isolated subagents do not inherit the plugin, and
explicit trusted-group bypasses and session approvals can still bypass review.

### Upgrading from 0.16.2

0.21.0 includes the [long-command approval fix](https://github.com/hank-warren/pi-extensions/pull/63)
from 0.20.0: a bounded preview, pinned choices, and **Ctrl+O** to view the full
command with scrolling. The config loader still accepts the existing reviewer,
`rules`, and `guardianPolicy`; obsolete `reviewer.prefilter`, `standingApprovals`,
and `ui.placement` settings are ignored. Remove obsolete settings when updating,
without changing policy or custom rules.

0.17.0 removed the cross-session standing-approvals ledger and its prompt option.
Existing ledger files are no longer consumed; preserve them for rollback, and do
not silently copy their contents into `guardianPolicy.allow`. Durable policy
exceptions require separate user confirmation. Session-scoped prompt decisions
still persist on resume. Legacy `convention` rules become `deny`; their overrides
and `request_override` were removed.

0.18.0 added concurrent reviews and codemode-script evidence. Set
`reviewConcurrency: 1` to preserve serial scheduling. 0.19.0 added RPC approvals
and revise-first behavior for subagent sessions that load the plugin. 0.21.0's
unattended behavior is opt-in via `PI_AUTO_PERMISSIONS_UNATTENDED=1`; ordinary
interactive sessions still ask for approval.

The required [footer](#footer) shows the plugin's status after `/reload`:
`Auto: on · Luna low`, `Auto: off`, `Auto: unavailable` (Hank's settings command
is not loaded), `Auto: config error` (the package's own validator rejected the
config), or `Auto: unavailable (adapter)` — the footer's adapter is tested
against **0.21.0** and retains **0.16.2** compatibility. Other versions are
reported as unavailable until reviewed. `/auto-permissions` inspects the settings.
The status reflects the loaded plugin, not that any given review will succeed; the
footer never imports an absent guard, edits policy, or makes model calls.

## Footer

This repository's footer extension (code in `extensions/footer/`) is required.
Its entry point is still `extensions/auto-permissions-status/index.ts`, kept so
existing setups need no change. Enable it with `pi config`; for a local checkout,
add the absolute path to `extensions/auto-permissions-status/index.ts` to
`extensions` in `~/.pi/agent/settings.json`.

It replaces Pi's footer. The first row shows the directory, branch, pull request
link and session name, with the Auto Permissions status on the right; the second
shows token/cache/cost/context usage, with the main model on the right; a third
row shows other extensions' statuses. **Pi has one footer slot**, so do not run it
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
