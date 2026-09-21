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
  including workflow children, with a short ID, status and task brief. Silent
  children appear immediately; rows disappear on completion or cancellation, and
  the panel vanishes when empty.
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
  count and suppresses individual notifications. Workflow stages return only to
  their awaiting workflow.
- Status is paginated (`offset`, `limit`, or `id` with `outputOffset`); the registry
  retains 50 completed results alongside outstanding work. Oversized JSON records
  are skipped and flagged, not treated as a reason to kill an otherwise healthy
  child.
- Incomplete terminal results cannot count as success. Workflow retry does not
  automatically relaunch stalled, cancelled, expired, timed-out, or incomplete
  children. Journal persistence failure returns control for reconciliation rather
  than repeating unjournaled effects.

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
globally. The extension separately appends the effective profile catalog to the
parent's system prompt through a hook that calls the same resolver as the
read-only CLI—no subprocess is launched during prompt setup.

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

- Only `defaultProfile` and `profiles` are accepted at the top level. Each profile
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
