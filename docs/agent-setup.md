# Agent setup

[Back to README](../README.md)

## Global system-prompt append (agent setup)

Agent setup checklist:

1. Install this repository with the command in the [README](../README.md#install); use `pi config` to enable the
   desired extensions, including Subagents for profile-based delegation.
2. Install external plugins separately: [MCP / Linear](#mcp--linear-external-package)
   uses `pi-mcp-adapter`; the Auto Permissions status extension is only a display
   companion, not the permissions plugin itself (see its setup section below).
3. Symlink `APPEND_SYSTEM.md` using the guarded command below. Package installation
   does **not** install this link.
4. Run `/reload` or restart Pi after installing/enabling extensions and linking
   the append file. For profiles, optionally configure global/local overrides as
   described in [Subagent profiles](subagents.md#subagent-profiles).

[`APPEND_SYSTEM.md`](../APPEND_SYSTEM.md) is the version-controlled source for shared
cross-project instructions, including editable subagent selection guidance.
Keep repository rules in `AGENTS.md`. Pi appends this file to its default system
prompt rather than replacing it.

For subagents, **both pieces are included**: Pi loads the static selection guidance
from the symlinked file, and the enabled Subagents extension appends the effective
profile catalog through its prompt hook. The CLI only lets you inspect that same
catalog; the extension calls the shared resolver directly, not the Bash script.
Neither installing the package nor linking the file substitutes for the other.

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

Harbor MCP is retired and no longer bundled. Use the free external
[`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter):

```sh
pi install npm:pi-mcp-adapter@2.34.0
```

Follow [MCP setup](mcp-plugin-setup.md) for the configuration, then run
`/reload` and `/mcp-auth linear`. Use the `mcp` proxy to discover, describe and
call tools; native/direct tools are optional. The documented policy allows
Linear reads automatically and requires approval for current mutation-name
patterns. It is name matching, not semantic classification: review new unmatched
verbs. Other servers require approval by default. Keep credentials out of this
repository; do not load the retired client alongside the adapter.

Hide the persistent MCP footer with `"mcpFooterStatus": "off"` under `settings`
in `~/.pi/agent/mcp.json`, then `/reload`. Use `/mcp status` for on-demand status,
or `"compact"` instead of `"off"` for a shorter footer. This does not hide the
separate subagent tracker status.

## Automatic Bash permissions (external package)

This setup uses [Hank Warren's Auto Permissions](https://www.npmjs.com/package/@hank-warren/pi-auto-permissions),
installed separately from this repository. Install the pinned version globally:

```sh
pi install npm:@hank-warren/pi-auto-permissions@0.16.2
```

Pi adds `"npm:@hank-warren/pi-auto-permissions@0.16.2"` to the `packages` array in
`~/.pi/agent/settings.json`, preserving existing extensions. Do not also load the
upstream `@ogulcancelik/pi-auto-permissions` package: overlapping guards can cause
duplicate reviews.

Create `~/.pi/agent/pi-auto-permissions/config.json` (or under your
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

Enable this repository's **`auto-permissions-status`** extension with `pi config`
for a persistent footer indicator. For a local checkout, add its absolute path to
`extensions` in `~/.pi/agent/settings.json`:

```json
"/absolute/path/to/pi-extensions/extensions/auto-permissions-status/index.ts"
```

Run `/reload` or restart Pi, then use `/auto-permissions` to inspect settings.
The companion shows **`Auto: on · Luna low`**, **`Auto: off`**, or
**`Auto: unavailable`** when Hank's settings command is not loaded. It uses the
loaded package's own config validator; invalid settings show **`Auto: config error`**.
Its internal adapter is tested against **0.16.2**; unsupported versions show
**`Auto: unavailable (adapter)`** until the adapter is updated. It never imports
or enables an absent guard, edits policy, or makes model calls.

The indicator refreshes once per second, including while idle and after settings
menu changes, and clears its timer/status on reload or shutdown. In the TUI it
installs a compact custom footer: Auto is right-aligned on the directory/branch
row, with token/cache/cost/context usage and the main model below. Long paths are
truncated instead of adding a row. Other extensions' statuses retain their own
row. It restores the default footer on shutdown; do not combine it with another
custom-footer extension (Pi has one footer slot). The compact footer does not
show Pi's auto-compaction or experimental-mode badges. RPC keeps the normal status
API; headless sessions do no work.
Rules-only mode, an empty ruleset, and an enabled minimal-reasoning prefilter are
identified separately. This is **loaded-plugin/config status**, not a guarantee
that credentials, provider requests, or every command's review will succeed; it
does not inspect per-command bypasses or standing approvals.

Review is enabled by default across sessions. Authenticate to `openai-codex`
with `/login` and ensure
`gpt-5.6-luna` is available. The main agent can use a different model.

Every Bash command is subject to the plugin's rules and, absent a hard deny or
explicit bypass/standing approval, Luna review at low reasoning. The optional
single-token prefilter is disabled because it uses minimal reasoning regardless of
the full review setting. Full-shell review costs more than reviewing only commands
matched by the default rules. High-risk or uncertain actions may still require
human confirmation; enabled does not mean approve everything.

Put your natural-language preferences in `guardianPolicy`: trusted infrastructure
in `environment`, scoped exceptions in `allow`, restrictions requiring explicit
authorization in `softDeny`, and unconditional restrictions in `hardDeny`. These
preferences supplement the built-in policy; they do not override deterministic
hard-deny rules. No custom permissions are granted by the empty lists above.

**Coverage is Bash only, not an OS sandbox.** Edits, writes, MCP and desktop tools
are not gated. This repository's isolated subagents do not automatically inherit
this external plugin; do not assume child coverage. Existing trusted-group or
standing-approval configuration can bypass review. Usage and denial logs live next
to the config by default. The pinned package does not update automatically; review
new versions before explicitly upgrading.
