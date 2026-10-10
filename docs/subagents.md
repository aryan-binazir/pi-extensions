# Subagents

[Back to README](../README.md)

## Subagents and TypeScript workflows

The `subagent` tool starts a background Pi process and returns a task ID. It takes
an explicit task brief, a `reader` or `writer` permission preset, optional
profile/tools/model/extensions/cwd, and a bounded timeout — one hour by default,
including approval and queue time.

- **Permissions.** Default and preset tools are limited to the parent's active
  permissions; explicit tool requests outside those permissions are rejected.
- **Model.** Children default to the `implement` profile:
  **openai-codex/gpt-6-astra, medium**. [Named profiles](#subagent-profiles) select
  model and thinking independently of permissions. Fast aliases use the base model
  without the priority-tier extension.
- **Concurrency.** Up to eight children run concurrently by default; same-directory
  writers still queue behind one another. No new token or spending quotas are
  imposed.
- **Panel.** One shared panel above the editor lists queued and running children,
  including workflow children, with a short ID, status and task brief on one
  truncated line each, running children first. From 10 terminal rows the panel
  takes at most half the terminal height: from 24 rows it lists up to nine
  children, or eight plus a `… N more` line counting hidden running and queued
  children; shorter terminals list fewer, down to one row and the summary. In the
  default layout, updates then stay on screen instead of forcing full redraws that
  clear scrollback. Silent children appear immediately; rows disappear on
  completion or cancellation, and the panel vanishes when empty.
- **Results.** Completion is pushed into the parent conversation; output and usage
  remain available through `subagent_status`, which inspects the registry.
- **Cancellation.** `subagent_cancel` or `/subagents cancel ID` cancels one task.
  `subagent_cancel` with `id: "all"`, or `/subagents cancel all`, stops current
  children and workflows without disabling future delegation. Aborting the parent
  turn also stops its children.

Cleanup and liveness:

- Timeouts, cancellation and session shutdown terminate process groups, including
  descendants in those groups. Separate groups and sessions — including stock Pi's
  detached bash jobs — depend on Pi's own graceful cleanup; if Pi is wedged or
  killed first, those jobs can escape portable group cleanup.
- A Node supervisor watches an inherited owner pipe and cleans up on owner loss.
  This is supervision, not machine-wide subscription control.
- Four consecutive identical failed tool calls stop a child as `stalled`.
  Productive work and successful polling are not turn-limited.

Reporting:

- Direct completions and individual cancellations are compact and batched. A batch
  containing only cancellations does not trigger a model turn; cancel-all returns a
  count instead of notifications for the children it cancels; other completions,
  including ones already batched, are still pushed. Session shutdown discards
  pending notifications. Workflow stages return only to their awaiting workflow.
- Status is paginated (`offset`, `limit`, or `id` with `outputOffset`); the registry
  retains 50 completed results alongside outstanding work. Oversized JSON records
  are skipped and flagged, not treated as a reason to kill an otherwise healthy
  child.
- Incomplete terminal results cannot count as success. Workflow retry does not
  automatically relaunch stalled, cancelled, expired, timed-out, or incomplete
  children. Journal persistence failure returns control for reconciliation rather
  than repeating unjournaled effects.

### Connector delegation

Connector delegation requires Pi 0.99.1 or newer with `ExtensionToolContext.tools`
and `executeTool`. Configure exact parent tool names in the user-scoped
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/subagents.json`. Preserve any existing profile
settings in that file. For example:

```json
{
  "delegatedTools": {
    "mcp__jira__get_issue": "read",
    "mcp__jira__get_issue_comments": "read",
    "mcp__jira__search_issues": "read"
  }
}
```

Run `/reload`, then select the tools explicitly in `subagent` or workflow
`api.spawn`:

```ts
await api.spawn({
  task: "Read the issue and comments, then summarize the evidence.",
  profile: "research",
  preset: "reader",
  tools: ["read", "mcp__jira__get_issue", "mcp__jira__get_issue_comments",
    "mcp__jira__search_issues"]
}, "jira-research");
```

Pi's built-in MCP names tools `mcp__<server>__<tool>`. The example assumes a server
named `jira` offering those three tools. Use your parent session's exact names.
The reported `claude_jira_*` names work only if that integration registers them
as callable Pi tools. Adapter-only tools cannot be delegated through this API.

MCP defaults to `codemode` exposure, which leaves individual tools inactive.
In the existing Jira server entry in user-scoped `mcp.json`, expose only the
selected tools directly, preserving its connection settings and credentials:

```json
"toolExposure": {
  "get_issue": "direct",
  "get_issue_comments": "direct",
  "search_issues": "direct"
}
```

Run `/reload` after changing either file. This extension edits neither file.
`delegatedTools` grants delegation only; it does not connect or authenticate a
server. Settings from other subagent implementations do not apply here.

The delegation contract is:

- A connector must have an exact `read` or `write` grant, be explicitly selected,
  be active in the parent, and be callable through the parent's `executeTool` API.
  Hidden and model-only tools cannot be forwarded. Deferred/codemode tools still
  need to be active for delegation, even if another parent tool can call them.
- Grants belong only in user-scoped `subagents.json`. Project settings and model
  profiles cannot add or reclassify grants. Wildcards are unsupported. At most
  64 connector names are allowed, each with 1–128 letters, digits, underscores,
  dots, or hyphens. Built-in and subagent control tools cannot receive grants.
- `read` is the operator's explicit classification, not an inferred guarantee
  from a name or connector annotation. Review what the tool does before granting
  it. The `reader` preset rejects `write` grants and built-in `bash`, `write`, and
  `edit`. Model profiles do not grant permissions. Omitting `tools` keeps the
  existing built-in defaults; it never adds connectors implicitly.
- Unavailable, ungranted, inactive, or uncallable tools fail before spawning,
  with the offending names and corrective steps. Queue admission, launch, each
  forwarded call, and cached workflow stages recheck the applicable permissions.
- A bundled child extension registers proxies for only the selected connectors,
  before any explicitly approved child extensions. A private inherited descriptor
  carries definitions, arguments, and results through the existing supervisor.
  There is no socket server or generated connector configuration. Connector
  callbacks, authentication, and permission hooks remain in the parent.
- Parent permission blocks and connector failures keep their `isError` flag.
  Messages are limited to 1 MiB and 32 executing requests per child. Optional
  `structuredContent` is omitted when it would exceed the frame limit; visible
  content and details still travel. Oversized visible results fail explicitly.
  Cancelled requests retain their execution slots until the parent call settles.
  Cancellation, timeout, transport loss, child exit, and
  shutdown abort task-scoped parent requests. A connector must honor its signal
  to stop an in-flight external operation. Pi permission dialogs may remain until
  their own hook resolves; an aborted request cannot then execute the connector.
- Children remain separate processes, not OS sandboxes. They retain the existing
  inherited environment and filesystem behavior. The bridge does not copy
  connector credentials into briefs, logs, settings, or repository files.

Node and Bun children use the same private descriptor. Bun uses filesystem
streams because its socket constructor cannot read an inherited socket descriptor.
The child closes the parent connection when its delegated run settles, after
automatic retries and context recovery, releasing Bun's descriptor reader.
Initialization fails after five seconds without metadata.

Without connector grants, existing profile and workflow identities remain
compatible. Enabling or reclassifying grants, activating tools, changing profile
settings, or switching trusted worktrees can change workflow identity. A new
identity starts a new journal and can run completed stages again; reconcile prior
writer results before rerunning. Settings and worktree changes also invalidate
later connector calls from an already-running child; resubmit that child.

Pi 0.99.1 permits calls through the captured parent context after a background
spawn has returned. Its nested-call records can miss those late calls, usage
accounting can be incomplete, and nested call IDs can restart after another
parent turn. Workflow calls remain inside their originating tool invocation.
The extension keeps the parent execution pipeline intact and does not patch
Pi's transcript bookkeeping. See the separate
[continuation investigation](subagent-continuation.md) for reproduction steps
and what remains unverified.

### Workflows

Workflows require a separate Node executable on `PATH` (22.19+ in the 22.x series,
or 24+), including when Pi itself runs on Bun. Its version and permission
enforcement are probed before execution; missing or unsupported Node fails
explicitly.

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
the journal; current directives still propagate to new children. Failed stages run
again, and unfinished capability calls prevent a successful workflow result.

Journal storage and retention:

- Each journal is a directory (mode 0700) under
  `${PI_CODING_AGENT_DIR:-~/.pi/agent}/workflow-journals/`, holding one atomically
  replaced file (mode 0600) per spawn stage or checkpoint. A write costs one stage.
- `api.spawn` resolves to the child's status, output, usage, brief, cwd and
  model/thinking/profile provenance, with stderr clipped to its last 4 KiB. The
  journal records that value, and replay returns it unchanged.
- A stage record holds at most 1 MiB and a journal at most 32 MiB. Each child
  reserves 1 MiB before launch; when unfinished stages hold the remaining budget,
  new children wait. Once completed stages leave less than 1 MiB, `api.spawn`
  rejects before launching, and a checkpoint that does not fit rejects unrecorded.
  The script can catch either error; a rerun replays the recorded stages and stops
  at the same stage without relaunching it. Split the workflow, or have children
  write bulky results to files.
- Journals stay replayable, including after success, until unused for seven days.
  Beyond the 16 most recently used, journals idle for over two hours are deleted.
  Pruning runs when a workflow starts and skips running workflows. Single-file
  journals from earlier versions are not replayed and are pruned the same way.

Replay limits:

- Replay is deliberately opt-in. Resuming requires source approval and an explicit
  replay confirmation; declining stops that invocation without starting children.
- Replay reuses recorded results; it does not prove that prior file effects still
  exist. Confirm replay only after checking that those effects remain valid.
- To rerun every stage, change the source (for example, add a revision comment),
  review it again, and approve the resulting fresh journal.
- Each synchronous worker evaluation is limited to 100 ms, independently of the
  overall workflow timeout.
- A journal write failure stops subsequent journal writes in that invocation;
  rerun after correcting storage rather than retrying unjournaled effects.

### Subagent profiles

Use `profile` in either `subagent` or workflow `api.spawn`:

```ts
await api.spawn({task: "Inspect the API contract", profile: "research", preset: "reader"}, "contract");
await api.spawn({task: "Implement and verify the agreed change", profile: "implement", preset: "writer"}, "implement");
```

Bundled profiles are `research` (Luna medium), `implement-small` (Astra low),
`implement` (Astra medium, default), `implement-complex` and `review` (Astra high).
Guidance on which one to choose lives in the shared
[`APPEND_SYSTEM.md`](../APPEND_SYSTEM.md); use the
[symlink setup](agent-setup.md#global-system-prompt-append-agent-setup) to load it
globally. The extension contributes the effective profile catalog through the structured
`subagent_profiles` prompt section, using the same resolver as the read-only
CLI—no subprocess is launched during prompt setup. It does not force-replace the
system prompt, so other sections such as active-worktree notices and submitted
editor snapshots remain visible to providers.

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

Accepted schema:

- `defaultProfile` and `profiles` are accepted in either settings file.
  `delegatedTools` is accepted only in the user-scoped file, as described above.
  Each profile
  accepts `model`, `thinking`, `description` and `useWhen`; new profiles require
  model and thinking, and text fields default empty.
- Names use lowercase letters, digits and hyphens, start with a letter, and have at
  most 48 characters.
- At most 24 profiles, 240 characters per text/model field, and 64 KiB per settings
  file are accepted.
- Missing files fall back. Malformed files, unknown fields/profiles and unavailable
  selected models fail explicitly: configure models/auth in Pi (`models.json`,
  `/login`) or remap the profile, then `/reload`. There is no model substitution.
- Model availability uses Pi's registry snapshot, not a network entitlement check.
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

Snapshot lifetime and provenance:

- The effective settings snapshot lasts until session start/reload, or an active
  cwd/trust change. Local settings are read only at that cwd, never ancestors.
- A routed worktree cannot reuse the original session's trust: its local settings
  are excluded until the worktree is opened as Pi's own trusted session cwd.
- Local files are machine-owned and gitignored; this does not untrack files already
  committed. Settings symlinks and non-regular files are rejected.
- `subagent_status` includes each task's profile, resolved model/thinking, bounded
  field provenance and configuration fingerprint. Tool descriptions refresh profile
  choices without enabling tools.
- Workflow identity includes the effective configuration and the captured parent
  model/thinking; a change starts a different journal. Cached spawn stages recheck
  model availability, and new stages fail if cwd, trust or configuration changed
  during approval or execution.
- The report-only Luna tracker remains independent and unchanged.

## Background tracker

Registered subagents share one report-only `openai-codex/gpt-5.6-luna` tracker
with medium reasoning per owning session, covering direct and workflow children.

- **Cadence.** It starts asynchronously with work, then requests at most once per
  minute with a 30-second deadline. After a successful report, unchanged task state
  skips both the model call and the report; token/cost usage changes alone do not
  count as progress. Task identity, status, brief, output or error changes can
  trigger the next report. Failed requests retry at the same cadence, and stopping
  tracking resets deduplication.
- **Snapshot.** At most four running children, queued counts and four recent
  completed children, with clipped briefs/output and usage. No parent history is
  sent.
- **Output.** Reports are capped at 2,000 characters. A sanitized plain-text preview
  (at most 100 display columns, word-safe ellipsis) replaces one footer status slot
  without a tracker prefix; terminal width is used when available at publication,
  and Pi still owns final footer layout. `/subagents` includes the full latest
  report — not necessarily current task state — alongside task and tracker status,
  and `subagent_status` also exposes tracker status and errors while preserving task
  details. Reports never enter chat history or model context and never wake the
  parent.
- **Lifecycle.** The slot clears when work finishes, on cancel-all, or on shutdown.
  Idle, cancel-all and shutdown abort tracking; tracker errors survive going idle,
  and later delegation starts tracking again.
- **Authority.** Missing model or auth never selects a fallback. The tracker has no
  tools or execution authority; deterministic task supervision remains independent.
