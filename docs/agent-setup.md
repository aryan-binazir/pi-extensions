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
   with PR links, and Claude bridge are required;
   a missing or disabled component
   is setup drift, not a skipped optional feature.
2. **Shared instructions:** verify `APPEND_SYSTEM.md` is a readable symlink to
   this repository's tracked file in a stable checkout. With Subagents selected,
   also check its profile catalog is available; the file link alone is insufficient.
3. **Required and opted-in features:** follow the corresponding README step for
   Escape Continue, Bash approvals, Hooks, the footer with PR links, Claude bridge,
   and each configured or requested optional feature. For Escape Continue, compare
   selected entrypoints with [its configuration requirements](#escape-continue),
   read-only. Check external package pins and their documented config;
   for Bash approvals, check the reviewer settings and the required
   [shared reviewer policy](#shared-auto-permissions-policy): `guardian-prompt.md`
   beside the active config must be a readable symlink to this repository's policy
   in a stable checkout, selected by `systemPromptFile: "./guardian-prompt.md"`;
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
`PI_CODING_AGENT_DIR`). Use the existing `openai-codex` connection and enable
Fast mode (`extensions/fast-mode/index.ts`) before Auto Permissions so
`gpt-6-luna~fast` resolves. With package installation, keep this repository's
package before Auto Permissions in `settings.json.packages`; local extension
paths load before packages. If that connection
is unavailable, ask Ar before writing the config. Set `reasoningEffort` explicitly
to `low`.

```json
{
  "enabled": true,
  "reviewAllShell": true,
  "systemPromptFile": "./guardian-prompt.md",
  "rules": ["$defaults"],
  "reviewConcurrency": 1,
  "reviewer": {
    "provider": "openai-codex",
    "model": "gpt-6-luna~fast",
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

Install the [shared reviewer policy](#shared-auto-permissions-policy) before
using this configuration; a missing prompt file fails closed. This example is a
scaffold: installation must also populate the required Railway `hardDeny` entry
from the shared policy as described below.

Review is then on by default across sessions: every Bash command goes through the
rules and, absent a hard deny, trusted-group bypass or session approval, Luna review
at low reasoning with priority processing requested. The `~fast` alias sends
`service_tier: "priority"` while retaining the real model ID `gpt-6-luna`.
It reuses Pi's existing Codex authentication; no separate classifier API key is
needed. This is the Bash approval reviewer, not Pi's separate Decisions API.
Priority availability and latency depend on the provider; fast mode does not
guarantee a speedup, and provider tier pricing applies.

Complete any required sign-in for the existing model connection and verify the
alias resolves after `/reload`. Test a harmless Bash command and confirm the
reviewer uses low reasoning and priority processing. Keep the main model,
startup thinking, and unrelated model settings unchanged.
`reviewConcurrency: 1` preserves serial reviews; the package default is four.
The prefilter was removed in 0.17.0, so every reviewed command gets full review.
`guardianPolicy` takes natural-language preferences: trusted
infrastructure in `environment`, scoped exceptions in `allow`, restrictions
needing explicit authorization in `softDeny`, unconditional ones in `hardDeny`.
They supplement the active reviewer prompt and never override deterministic hard denies.
**Coverage is Bash only, not an OS sandbox:** edits, writes, MCP and desktop tools
are not gated, this repository's isolated subagents do not inherit the plugin, and
explicit trusted-group bypasses and session approvals can still bypass review.

### Shared Auto Permissions policy

[`personal-settings/auto-permissions.md`](../personal-settings/auto-permissions.md)
is the required, version-controlled reviewer prompt. It carries the shared
local-autonomy and single-operation Bash policy across machines. It is a complete
replacement for the package's built-in reviewer prompt, not an addition to the
main agent's `APPEND_SYSTEM.md`. It is adapted from the pinned package's prompt;
see its [license](../personal-settings/auto-permissions.LICENSE). Review this file
alongside future Auto Permissions upgrades.

Install it once on each machine after user approval:

1. Choose a **stable checkout** of this repository (the source path shown by
   `pi list` is also suitable if it will remain installed). Resolve the absolute
   path to `personal-settings/auto-permissions.md`. Package installation ships
   this file but does not configure Auto Permissions to use it.
2. Resolve the active config from `PI_AUTO_PERMISSIONS_CONFIG` when set, otherwise
   `$PI_CODING_AGENT_DIR/pi-auto-permissions/config.json` (agent directory defaults
   to `~/.pi/agent`). Inspect its existing `systemPromptFile` or inline
   `systemPrompt`, and `guardian-prompt.md` beside the config. A readable symlink
   to the chosen shared source is already linked. Preserve existing files and
   links (including broken links), and ask before replacing or migrating them.
3. Back up an existing config beside its original with a dated `.bak` suffix,
   preserving permissions and using no-clobber or exclusive creation (for example,
   `cp -pn` with a fresh filename). Skip backup when creating a new config.
   Create the config directory if needed. Create `guardian-prompt.md` beside the
   active config as a symlink to the shared source's absolute path on this machine.
   Use `ln -s <absolute-shared-source> <absolute-config-directory>/guardian-prompt.md`
   only after verifying the destination is absent; never force-link over existing
   files or links. Keep the policy in the checkout rather than copying its contents
   into the agent directory. If a protection hook refuses link creation, ask the
   user to run that exact command and verify the result; do not bypass the hook or
   silently substitute a direct file reference.
4. Verify the link exists, is readable and resolves to the selected shared source
   **before** switching config. Make the smallest textual change to set
   `"systemPromptFile": "./guardian-prompt.md"`. If an inline `systemPrompt` exists,
   remove it only as part of the approved migration: the package rejects setting
   both. Preserve `enabled`, `reviewAllShell`, reviewer settings, `rules`,
   infrastructure policy and other unrelated entries. Leave old prompt files intact
   for rollback. The relative config value is identical across machines; only each
   symlink's target is machine-specific. Keep credentials and trust exceptions local.
   Append the exact first paragraph under **Railway database hard deny** in the
   shared prompt to `guardianPolicy.hardDeny` if absent, preserving existing entries.
   This is the required unconditional prohibition on destructive Railway database
   and persistent-storage operations, not a trust exception. The shared paragraph
   is the source of truth; obtain approval before migrating a conflicting policy.
5. Show the diff and validate using the installed package's
   `config.ts` / `loadAutoPermissionsConfig` through Pi's SDK-aware loader.
   Verify its `systemPromptSource.path` is the local `guardian-prompt.md` link,
   that the link resolves to the chosen checkout's policy, and that the loaded
   prompt matches that file. Verify `guardianPolicy.hardDeny` contains the canonical
   Railway paragraph without changing other rules or timeout behavior. If loading
   fails, restore the prior config. Report an unavailable validator as unverified
   rather than claiming success. Validate configuration only: do not run Railway
   commands, destructive operations, probes, dry runs or destructive-operation tests.

Completion: the live config uses `systemPromptFile: "./guardian-prompt.md"`, and
that readable symlink resolves to the shared policy, with Bash review enabled,
`reviewAllShell: true`, the required reviewer model/effort, the canonical Railway
`hardDeny` entry and existing deny rules preserved. Missing, stale or unreadable
links and direct-reference or copied-policy
installations are setup drift; report those in the read-only audit and ask before
repair. Keep subsequent shared policy
changes in this repository rather than editing a local copy. Pulling the checkout
updates configured machines on their next guardian review; moving/removing it
requires updating the symlink target. Config/prompt-only changes need no
`/reload`; extension installation or selection changes still do. Validate actual
reviewer behavior separately: the policy is model guidance, not a deterministic
shell parser or OS sandbox.

The policy distinguishes **revise** (tell the agent to split chained operations,
without interrupting the human) from **ask_user** (a material authorization or safety
boundary). An explicitly chosen push repository/remote/branch carries forward for
follow-up delivery of the same work, including a selected `main` target; "push those"
does not require repeating it. Later target changes take precedence. This is not
permission for another repository/task, force pushes, production effects or skipping
verification. Routine task-related local work, including scripted source/test edits,
is preauthorized. Non-overwriting sibling backups of the config being worked on
are part of authorized setup, even outside the repository; potentially overwriting
copies receive revision guidance rather than a prompt. Screenshot/media-only
pushes to dedicated `pr-assets/...` branches on the existing repository remote are
also covered, including standing `--no-verify` permission for those asset pushes.
For ordinary code, verification/hooks stay enabled unless the user explicitly
permits skipping them for the current operation. An otherwise authorized code
command with an unapproved bypass receives **revise** guidance to remove it and
resubmit normally, not a human approval prompt. Explicit user instructions to
verify override prior skip permission and the screenshot exception. Sensitive
effects retain review. Feedback should fit the command: `git -C` for Git, absolute paths or
read/search tools for file inspection.

#### Railway database boundary

Destructive Railway database or persistent-storage operations are forbidden in
all environments, including through SQL clients, migrations, scripts and delegated
agents. The shared prompt contains the canonical wording; setup mirrors that
paragraph into the user-scoped `guardianPolicy.hardDeny` array. Approval is not an
exception. Keep read-only inspection available; do not validate this policy by
running Railway commands or destructive tests.

This is a **reviewer-enforced** hard policy, not a new deterministic CLI guard or
OS sandbox. Hidden/delegated effects and non-Bash tools retain the coverage limits
above. Timeout/cancellation handling is unchanged: a failed review can still show
the fallback approval prompt. That prompt must not be used to override the Railway
prohibition. Restrictive database credentials provide a stronger boundary than
prompt policy alone.

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
`Auto: on · gpt-6-luna~fast low`, `Auto: off`, `Auto: unavailable` (Hank's settings command
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
