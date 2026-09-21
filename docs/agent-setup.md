# Agent setup

[Back to README](../README.md)

## Global system-prompt append (agent setup)

The ordered setup checklist — install, link, external plugins, reload — is in
the [README](../README.md#agent-setup-checklist). This page covers the three
steps that need more than one line: the append-file link, and the two external
packages.

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

## MCP / Linear (external package)

General MCP connectivity uses the separately installed free
[`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter). Its
installation, configuration, approval policy, footer settings and Linear
authentication are documented in [MCP / Linear setup](mcp-plugin-setup.md).

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
    "model": "gpt-5.6-luna",
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
`gpt-5.6-luna` is available; the main agent can use a different model. The
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
