# Pi interactive tools

Fourteen independently selectable extensions for Pi 0.85.1. Install from this
private Git repository using your existing GitHub SSH access:

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
```

Installation uses Pi's package manager and does not require a build. Run `/reload` in an existing
Pi session, then use `pi config` to select extensions. The manifest lists only each feature's `index.ts`; helper and test
files are never entrypoints. Prompt stash uses `Ctrl+S` only while the main prompt
editor has focus. Pi's model/thinking save and session-selector bindings remain
unchanged, with no shortcut conflict warning or keybindings configuration needed.

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
| Prompt stash | `Ctrl+S` | Stash, restore or swap one draft slot; a footer indicator shows occupancy. |
| Subagents | `subagent`, TypeScript workflows | Isolated task contexts, bounded background execution and approved workflow replay. |
| Worktree | `/worktree` | Create or reuse a checkout and route the current session's shell and relative file tools. |
| Computer use | Desktop tools | Pi directs native Linux desktop tools or seven app-targeted macOS tools through the official Codex computer-use service. See [desktop setup](extensions/computer-use/README.md). |
| Fast mode | `/fast` | Toggle supported base/fast model entries while retaining provider authentication and reasoning. [Provider support](docs/adr/006-search-fast-power.md). |
| Auto-caffeinate | Agent lifecycle | Temporarily inhibit idle sleep during work on confirmed AC power, including background tasks. |
| Auto Permissions status | Persistent footer | Display-only companion to Hank Warren's plugin: on/off, reviewer and effort, or unavailable/config error. |
| Sentinel | `/auto on`, `/auto off`, `/sentinel reload` | Default-off adaptive Luna review, with user-owned standing preferences and inherited child coverage. [Setup and boundaries](extensions/sentinel/README.md). |

## Global system-prompt append (agent setup)

Agent setup checklist:

1. Install this repository with the command above; use `pi config` to enable the
   desired extensions, including Subagents for profile-based delegation.
2. Install external plugins separately: [MCP / Linear](#mcp--linear-external-package)
   uses `pi-mcp-adapter`; the Auto Permissions status extension is only a display
   companion, not the permissions plugin itself (see its setup section below).
3. Symlink `APPEND_SYSTEM.md` using the guarded command below. Package installation
   does **not** install this link.
4. Run `/reload` or restart Pi after installing/enabling extensions and linking
   the append file. For profiles, optionally configure global/local overrides as
   described in [Subagent profiles](#subagent-profiles).

[`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) is the version-controlled source for shared
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

Follow [MCP setup](docs/mcp-plugin-setup.md) for the configuration, then run
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
The stash is memory-only and clears on session start, switch and reload. Vi mode preserves pasted tabs, carriage returns and newlines while editing and stashing. It strips unsafe terminal controls at insertion, and normal submission additionally strips carriage returns. Large pastes use Pi-style collapsed markers. Motions, selections and edits treat each marker atomically, and undo, registers, stash and editor replacement retain its payload. The exact supported vi command set is documented in [ADR 001](docs/adr/001-editor.md). Counts apply to motions, operators, doubled line operators, `x`, `p/P` and `nG/ngg`; counts on insert entry, visual toggles, text objects and undo/redo are unsupported. Registers are lowercase `a-z` and the unnamed register.

## Subagents and TypeScript workflows

The `subagent` tool starts a background Pi process with an explicit task brief,
a `reader` or `writer` permission preset, optional profile/tools/model/extensions/cwd, and a bounded
timeout. Default and preset tools are limited to the parent's active permissions;
explicit tool requests outside those permissions are rejected. It returns a task ID.
One shared panel above the editor lists queued and running children (including
workflow children), with a short ID, status, and task brief. Silent children appear
immediately; rows disappear on completion or cancellation, and the panel vanishes
when empty. Completion is pushed into the parent conversation; output and usage
remain available through `subagent_status`, which inspects the registry;
`subagent_cancel` or `/subagents cancel ID` cancels a task. Up to eight children
run concurrently by default; same-directory writers still queue behind one another. Timeouts, cancellation and session shutdown terminate
process groups, including descendants in those groups. Separate groups/sessions,
including stock Pi's detached bash jobs, depend on Pi's own graceful cleanup;
if Pi is wedged or killed first, those jobs can escape portable group cleanup.

The default deadline is one hour, including approval and queue time. Children
default to the `implement` profile: **openai-codex/gpt-6-astra, medium**.
[Named profiles](#subagent-profiles) select model/thinking independently of permissions.
Fast aliases use the base model without the priority-tier extension. Aborting the
parent turn also stops its children.
A Node supervisor watches an inherited owner pipe and cleans up on owner loss;
this is supervision, not machine-wide subscription control. Four consecutive
identical failed tool calls stop a child as `stalled`; productive work and successful
polling are not turn-limited. No new token or spending quotas are imposed.
Use `subagent_cancel` with `id: "all"`, or `/subagents cancel all`, to stop current
children and workflows without disabling future delegation.

Direct completions and individual cancellations are compact and batched. A batch
containing only cancellations does not trigger a model turn. Cancel-all returns a
count and suppresses individual notifications. Workflow stages return only to
their awaiting workflow. Status is paginated
(`offset`, `limit`, or `id` with `outputOffset`); the registry retains 50 completed
results alongside outstanding work. Oversized JSON records are skipped and flagged,
not treated as a reason to kill an otherwise healthy child. Incomplete terminal
results cannot count as success. Workflow retry does not automatically relaunch
stalled, cancelled, expired, timed-out, or incomplete children. Journal persistence
failure returns control for reconciliation rather than repeating unjournaled effects.

Workflows require a separate Node executable on `PATH` (22.19+ in the 22.x series, or 24+), including when Pi itself runs on Bun. Its version and permission enforcement are probed before execution; missing or unsupported Node fails explicitly.

The `workflow` tool accepts a TypeScript async function body. The user reviews
the exact source and confirms execution. For example:

```ts
const plan = await api.spawn({
  task: "Inspect this checkout and describe the smallest fix. Do not edit.",
  preset: "reader"
}, "inspect");
return plan;
```

The worker exposes `spawn(task, stage)`, `parallel(functions)`,
`retry(attempts, function)`, `checkpoint(key, function)` and bounded
`readFile(path, maxBytes)`. Every child uses the same validation and inherited
policy as a direct subagent. The worker has a scrubbed environment, Node
filesystem/process permissions, a memory limit and a wall-clock timeout.
It exposes no host JavaScript objects as capabilities. This is not an OS sandbox;
Node permissions do not enforce a network boundary.

Successful stages are journaled under an identity that includes source, checkout,
policy permissions and runtime versions. Ordinary user messages do not invalidate
the journal; current directives still propagate to new children. Resuming requires source approval and an explicit
replay confirmation. Replay reuses recorded results; it does not prove that prior
file effects still exist. Confirm replay only after checking that those effects
remain valid. Declining aborts without starting children. Failed stages run again,
and unfinished capability calls prevent a successful workflow result.

### Subagent profiles

Use `profile` in either `subagent` or workflow `api.spawn`:

```ts
await api.spawn({task: "Inspect the API contract", profile: "research", preset: "reader"}, "contract");
await api.spawn({task: "Implement and verify the agreed change", profile: "implement", preset: "writer"}, "implement");
```

Bundled profiles are `research` (Luna medium), `implement-small` (Astra low),
`implement` (Astra medium, default), `implement-complex` and `review` (Astra high).
Use low only for a settled approach, local scope and clear verification; high for
substantial uncertainty or high risk. Task length alone is not a downgrade reason.
The extension appends the effective profile catalog to the parent's system prompt.
Editable selection guidance lives in the shared [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md);
use the symlink setup above to load it globally. The hook calls the same resolver
as the read-only CLI—no subprocess is launched during prompt setup.

Inspect the configuration from this checkout:

```sh
./extensions/subagents/show-config
./extensions/subagents/show-config --cwd /path/to/project --json
```

The CLI uses Node 22.19+ and installed repository dependencies, with no new runtime.
It reads local overrides only when Pi has **saved trust** for that project; it
never changes trust. Session-only trust/default trust policies are not inferred
by this standalone command. It prints freshly loaded settings, not a running
session's cached snapshot, and does not check live model availability. The
extension still uses the current session's trust and validates models at spawn.

Settings merge **field by field**: bundled defaults →
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/subagents.json` → trusted active-project
`.pi/subagents.local.json` → explicit spawn overrides. For example, either settings
file can contain:

```json
{
  "defaultProfile": "implement",
  "profiles": {
    "implement": {"thinking": "high", "useWhen": "Changes to this critical service"},
    "parent": {
      "model": "inherit",
      "thinking": "inherit",
      "description": "Parent selection",
      "useWhen": "Match the parent model and effort"
    }
  }
}
```

Edit the global file with `nvim ~/.pi/agent/subagents.json` (use
`$PI_CODING_AGENT_DIR/subagents.json` if the agent directory is customized).
To override it for one project, create `.pi/subagents.local.json` in that project's
root containing only the fields to change, for example:

```json
{
  "profiles": {
    "implement-small": {"thinking": "medium"}
  }
}
```

This keeps the global model, descriptions and other profiles, but uses medium
thinking for `implement-small` in that trusted project. Add
`.pi/subagents.local.json` to that project's `.gitignore` (already ignored in
this repository), then `/reload`. Remove the local override to restore the global
value on the next reload. A missing global file uses bundled defaults.

Only `defaultProfile` and `profiles` are accepted at the top level. Each profile
accepts `model`, `thinking`, `description`, `useWhen`. New profiles require model
and thinking; text fields default empty. Names use lowercase letters, digits and
hyphens, start with a letter, and have at most 48 characters. At most 24 profiles,
240 characters per text/model field, and 64 KiB per settings file are accepted.
Missing files fall back; malformed files, unknown fields/profiles and unavailable
selected models fail explicitly. Configure models/auth in Pi (`models.json`,
`/login`) or remap the profile, then `/reload`; there is no model substitution.
Model availability uses Pi's registry snapshot, not a network entitlement check.
Runtime-only provider extensions must also be explicitly available in the child;
profiles do not enable extension discovery or copy provider implementations.

`task.model` overrides the profile model, including `"inherit"` for the selected
parent model. Thinking precedence is `task.thinking` → explicit `task.model`
`:thinking` suffix → profile thinking. Inheriting a **model does not inherit
thinking**: set the profile's `thinking` to `"inherit"` to use the parent's level.
Explicit task thinking accepts Pi levels (`off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`), not `inherit`. Profile models keep thinking in its separate field.
Pi's capability clamping is applied and noted in status. OpenAI `~fast` aliases
resolve to their base model; child priority-tier extensions are not auto-loaded.

The effective settings snapshot lasts until session start/reload, or an active
cwd/trust change. Local settings are read only at that cwd, never ancestors.
A routed worktree cannot reuse the original session's trust: its local settings
are excluded until opened as Pi's own trusted session cwd. Local files are
machine-owned and gitignored; this does not untrack files already committed.
Settings symlinks/non-regular files are rejected. `subagent_status` includes each
task's profile, resolved model/thinking, bounded field provenance and configuration
fingerprint. Tool descriptions refresh profile choices without enabling tools.
Workflow identity includes the effective configuration and captured parent model/
thinking; a change starts a different journal. Cached spawn stages recheck model
availability. New stages fail if cwd/trust/configuration changed during approval
or execution. The report-only Luna tracker remains independent and unchanged.

## Worktrees

`/worktree feature` creates or reuses `amb/feature` at
`~/repos/.worktrees/<repo>/feature`. Use `--branch exact/name` to preserve an
explicit branch and `--base ref` to choose a starting ref. `/worktree list`
shows checkouts; `/worktree original` restores the original directory.
Active Herdr sessions use Herdr's worktree APIs; other environments use Git.
If an existing checkout's directory is missing or is no longer a directory,
opening it fails with its path instead of switching the session there. Restore
the directory to reuse it. For a deleted Git-managed checkout, first use
`/worktree original` if the session still targets the missing path, move aside
any file replacing the directory, then run
`git worktree remove --force /absolute/path` from the original repository and
retry. For Herdr-managed checkouts, restore the directory or resolve the missing
checkout in Herdr before retrying. The extension does not automatically discard
Git or Herdr state.

The conversation stays in the same session. Built-in bash, user shell commands
and relative file-tool paths use the active checkout. Absolute paths keep their
meaning. Pi's session storage, loaded instructions/resources and arbitrary
extension internals retain the original session directory. The footer and
per-turn instructions state this boundary. Read the new checkout's instructions
before editing.

`/worktree remove /absolute/path` requires confirmation and skips dirty trees.
Supply exactly one nonempty path argument; quote paths containing spaces.
`--force` explicitly allows dirty removal. `/worktree cleanup` additionally
requires a merged GitHub PR whose head still matches the checkout. These
commands preserve branch refs.

Delegated children are launched with a validated workspace and builtin tool list.
When Sentinel is enabled, children additionally inherit its classifier, blocking
reviewer, user policy, and root authorization. Without Sentinel, only launch-time
checks apply. Neither mode sandboxes child tools or trusted extension JavaScript.

## Automatic Bash permissions (external package)

This setup uses [Hank Warren's Auto Permissions](https://www.npmjs.com/package/@hank-warren/pi-auto-permissions),
installed separately from this repository. Install the pinned version globally:

```sh
pi install npm:@hank-warren/pi-auto-permissions@0.16.2
```

Pi adds `"npm:@hank-warren/pi-auto-permissions@0.16.2"` to the `packages` array in
`~/.pi/agent/settings.json`, preserving existing extensions. Do not also load the
upstream `@ogulcancelik/pi-auto-permissions` package or enable Sentinel: overlapping
guards can cause duplicate reviews. When installing this repository as a package,
use `pi config` to deselect Sentinel.

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

Review is enabled by default across sessions; no `/auto on` is needed (that command
belongs to Sentinel). Authenticate to `openai-codex` with `/login` and ensure
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

## Sentinel preferences (optional alternative)

Auto review is **off by default for new chats**. Use `/auto on` to review your
preferences and enable it for the current session, or `/auto off` to disable it.
Sentinel uses `openai-codex/gpt-5.6-luna` for asynchronous trajectory scoring and
`openai-codex/codex-auto-review` for blocking review when a recent low-risk score
cannot be reused. Your standing preferences belong in
`~/.pi/agent/sentinel-policy.md`; both stages receive them. Optional settings live
in `~/.pi/agent/sentinel.json`. Mid-session file changes block until reviewed with
`/sentinel reload`. See [Sentinel documentation](extensions/sentinel/README.md)
for examples, authentication, adaptive-review limits and subagent inheritance.

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

This package does not change host launchers, shell aliases, global defaults or
authentication.

Workflow replay is deliberately opt-in. Declining replay stops that invocation. To rerun every stage, change the source (for example, add a revision comment), review it again, and approve the resulting fresh journal. Each synchronous worker evaluation is limited to 100 ms independently of the overall workflow timeout. A journal write failure stops subsequent journal writes in that invocation; rerun after correcting storage rather than retrying unjournaled effects.

External integrations never require a nested research or desktop-planning agent.
Desktop actions require a usable desktop service and its OS permissions. On macOS, install the official Codex computer-use client and ChatGPT/Codex bundled cua_node runtime; grant permissions to those apps, not the terminal. Run `/reload` after setup. Approval is explicit, never an automatic always grant; only the owned client/relay is closed, never the shared Sky service. See [setup and runtime limits](extensions/computer-use/README.md).
Linux accessibility is reported unavailable when no supported service exists.
The Linux/macOS CI matrix checks portable behavior; it does not prove a live Mac
desktop session or priority-service entitlement. Unknown power state leaves idle
sleep settings untouched. No live provider call is needed for the fixture tests.

Registered subagents share one report-only `openai-codex/gpt-5.6-luna` tracker
with medium reasoning per owning session, covering direct and workflow children.
It starts asynchronously with work, then requests at most once per minute with a
30-second deadline. After a successful report, unchanged task state skips both
the model call and report; token/cost usage changes alone do not count as progress.
Task identity, status, brief, output or error changes can trigger the next report.
Failed requests retry at the same cadence; stopping tracking resets deduplication.
Snapshots contain at most four running children, queued
counts and four recent completed children, with clipped briefs/output and usage;
no parent history is sent. Reports are capped at 2,000 characters; a sanitized
plain-text preview (at most 100 display columns, word-safe ellipsis) replaces one
footer status slot without a tracker prefix. Terminal width is used when available
at publication; Pi still owns final footer layout. `/subagents` includes the full
latest report (not necessarily current task state), alongside task and tracker status. Reports never enter chat
history or model context and never wake the parent. The slot clears when work
finishes, on cancel-all, or on shutdown.
`subagent_status` also exposes tracker
status/errors while preserving task details. Missing model/auth never selects a
fallback. The tracker has no tools or execution authority; deterministic task
supervision remains independent. Idle, cancel-all and shutdown abort tracking;
tracker errors survive going idle. Later delegation starts tracking again.
