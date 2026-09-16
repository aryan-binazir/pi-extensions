# ADR 008: Supervised agents and approved TypeScript workflows

Status: accepted

Each subagent runs a separate Pi print/JSON subprocess initialized with an explicit task brief. Parent history is not copied. Model, builtin tools, preset, canonical cwd, explicit local extension paths, and deadline are validated before launch. Automatic extension/skill/template discovery is disabled. Trusted local extensions need explicit UI approval and execute with host privileges. They may contribute hooks and commands; custom extension tools are excluded by the child built-in tool allowlist. Source and extension approval work in TUI and RPC sessions with UI support.

A session registry owns a bounded queue, streams text/token usage, and pushes completion messages into the parent conversation. Four subprocesses may run concurrently. Writers targeting the same canonical directory serialize; readers may overlap. This coordination is local to the parent registry, not a cross-process repository lock. Cancellation, deadline, session replacement, and shutdown terminate the process group and reap the child. Ordinary descendants are killed even when the leader exits first. A program deliberately detaching into another process group is outside this portable cleanup guarantee. Context separation and extension interception are not OS sandboxes.

Workflow tools accept the body of an async TypeScript function. The user reviews the complete source in the editor, must submit it unchanged, then confirms execution. Missing UI, approval errors, and rejection stop before compilation or subprocess launch. TypeScript is transpiled in the parent. The parent resolves a real Node executable through PATH, probes its version and denied filesystem/process capabilities, and fails closed if unavailable or unsupported. This works when Pi is a Bun executable; Pi's executable path and emulated Node version are never used for the worker. A separate memory-bounded Node worker uses the permission model and a VM context with string/Wasm code generation disabled. The VM receives no host functions, objects, environment, imports, or filesystem handles. JSON IPC exposes only spawn, parallel (16 entries), retry (5 attempts), checkpoint, and readFile (64 KiB). Each VM evaluation has a CPU deadline; the parent also owns an overall deadline and cancellation. These restrictions are defense in depth for explicitly approved source, not a claim that Node VM provides an OS security boundary.

Every spawn requires a stable explicit stage label, passes the same launch-time workspace and builtin-tool validation as direct delegation, and uses the registry's limits. Workflow reads are canonicalized, bounded to its cwd, and reject sensitive paths. Children exceeding parent tools or cwd are rejected. Workflow completion with unfinished capability calls is an error; failure and abort cancel outstanding children and await their cleanup.

Successful stages are atomically journaled in the Pi agent directory. Replay identity includes exact source, canonical cwd, policy envelope, Node/TypeScript versions, and platform. Explicit stage labels avoid scheduler-dependent replay; concurrently duplicated labels fail. Source approval is required again on resume, followed by a separate confirmation listing the stages that will be reused. Declining stops without new work. Cached child stages still revalidate their task and current permissions.

Replay deliberately does not prove that previous file effects still exist. The replay dialog requires the user to confirm that the cached outputs and side effects remain valid in the current checkout. A changed source or policy starts a different journal. Checkpoints are successful-stage reuse, not rollback or transactional filesystem snapshots; an interrupted external effect may require human reconciliation before retry.


## Named model/thinking profiles

Delegation defaults to `implement` (openai-codex/gpt-6-astra medium), not implicit
parent inheritance. Committed defaults merge field-by-field with agent-directory
`subagents.json`, then trusted current-cwd `.pi/subagents.local.json`; explicit
spawn fields win. Reader/writer presets remain permission-only. Configuration
cannot add tools, extensions, cwd authority or tracker settings. See the
[profile schema and precedence](../../README.md#subagent-profiles).

A session/reload snapshot drives direct spawns, workflow spawns, generated parent
guidance and dynamically re-registered tool descriptions. Cwd/trust transitions
replace the snapshot. Routed cwd trust is deliberately not inferred from the
original session; local overrides require a matching trusted Pi session cwd.
Missing files are optional; invalid configuration blocks delegation until reload.
Selected models use Pi ModelRegistry `find`/`getAvailable` with OpenAI fast aliases
reduced to base IDs; no fuzzy or fallback model selection is performed here.
Thinking is capability-clamped with Pi's helper and exposed with provenance.

Workflow identity includes configuration provenance/content and captured parent
selection (conservatively even for profiles that do not inherit). Cached spawn
stages resolve again before replay; live stages reject cwd/config changes.
Per-task status retains bounded profile/selection provenance, not full settings.
The report-only Luna tracker is not a profile and its defaults are unchanged.
