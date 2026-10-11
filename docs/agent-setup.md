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
   skipped, not missing setup. Claude bridge is required; a missing installation
   is setup drift, not a skipped optional feature.
2. **Shared instructions:** verify `APPEND_SYSTEM.md` is a readable symlink to
   this repository's tracked file in a stable checkout. With Subagents selected,
   also check its profile catalog is available; the file link alone is insufficient.
3. **Required and opted-in features:** follow the corresponding README step for
   Claude bridge and each configured or requested optional feature. Check external
   package pins and their documented config;
   for Bash approvals, check the reviewer settings and status-extension selection;
   for Guard, check its selected entrypoint and readable rules link. For Claude
   bridge, use the offline model-list command below and preserve the separate
   `AskClaude` opt-in.
4. **MCP and runtime limits:** verify selected MCP support uses Pi's built-in
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

This setup uses [Hank Warren's Auto Permissions](https://www.npmjs.com/package/@hank-warren/pi-auto-permissions),
installed separately from this repository, pinned:

```sh
pi install npm:@hank-warren/pi-auto-permissions@0.16.2
```

Pi adds `"npm:@hank-warren/pi-auto-permissions@0.16.2"` to the `packages` array in
`~/.pi/agent/settings.json`, preserving existing extensions. The pin does not
update itself; review new versions before upgrading. Do not also load the
upstream `@ogulcancelik/pi-auto-permissions`: overlapping guards cause duplicate
reviews. Create `~/.pi/agent/pi-auto-permissions/config.json` (or under your
`PI_CODING_AGENT_DIR`):

```json
{
  "enabled": true,
  "reviewAllShell": true,
  "rules": ["$defaults"],
  "reviewer": {
    "provider": "openai-codex",
    "model": "gpt-6-luna",
    "reasoningEffort": "low",
    "timeoutMs": 60000,
    "prefilter": false
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
rules and, absent a hard deny or an explicit bypass/standing approval, Luna review
at low reasoning. Authenticate to `openai-codex` with `/login` and make sure
`gpt-6-luna` is available; the main agent can use a different model. The
prefilter stays off because it uses minimal reasoning whatever the full-review
setting says. `guardianPolicy` takes natural-language preferences: trusted
infrastructure in `environment`, scoped exceptions in `allow`, restrictions
needing explicit authorization in `softDeny`, unconditional ones in `hardDeny`.
They supplement the built-in policy and never override deterministic hard denies.
**Coverage is Bash only, not an OS sandbox:** edits, writes, MCP and desktop tools
are not gated, this repository's isolated subagents do not inherit the plugin, and
standing approvals can still bypass review.

Enable this repository's **`auto-permissions-status`** extension with `pi config`
for a footer indicator; for a local checkout, add the absolute path to
`extensions/auto-permissions-status/index.ts` to `extensions` in
`~/.pi/agent/settings.json`. After `/reload` the footer shows
`Auto: on · Luna low`, `Auto: off`, `Auto: unavailable` (Hank's settings command
is not loaded), `Auto: config error` (the package's own validator rejected the
config), or `Auto: unavailable (adapter)` — the companion's adapter is tested
against **0.16.2** only. `/auto-permissions` inspects the settings. It reports
loaded-plugin status, not that any given review will succeed, and never imports an
absent guard, edits policy, or makes model calls. Its compact TUI footer puts Auto
on the directory/branch row with token/cache/cost/context usage and the main model
below; **Pi has one footer slot**, so do not run it alongside another
custom-footer extension. It restores the default footer on shutdown.

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

Completion: `pi list` includes `npm:pi-claude-bridge@0.9.2`, and the model list
includes the `claude-bridge` provider. Ask the user to run `/reload`, then use
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
requested. Leave plan settings at their defaults unless the user specifies a
plan; Max users can set `provider.plan` to `"max"` in the same config to advertise
the appropriate context limits. This setting does not authenticate or upgrade a
plan.
