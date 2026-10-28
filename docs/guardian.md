# Guardian

[Back to README](../README.md)

Guardian ports Codex's approval stack to Pi: exec-policy rules, the Seatbelt sandbox on macOS and
the bubblewrap and seccomp sandbox on Linux, permission instructions for the agent, and the Guardian
auto-reviewer. Our inspiration from this code comes from there. The source is
[openai/codex](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897)
(Apache-2.0; see [third-party notices](licenses/README.md)). [ADR 025](adr/025-guardian.md)
records where it departs from Codex.

## How a command is decided

Guardian replaces Pi's `bash` tool and gates `write`, `edit`, and connector leaf calls.

1. Rules decide first. A script is split into command segments when it contains only plain words
   joined by `&&`, `||`, `;` or `|`. Each segment is matched against `.rules` prefixes, and the
   strictest decision wins: `forbidden`, then `prompt`, then `allow`.
2. A `forbidden` match is rejected before anything runs. A `prompt` match needs approval.
3. Unmatched commands run inside the sandbox without review, unless they force-remove files
   (`rm -f`, including inside `sudo`, `env`, `trap` and nested shells) or ask to leave the sandbox. A
   destructive database operation whose target is not provably local is refused outright (see
   [Shared rules: Railway](#shared-rules-railway)).
4. The sandbox lets commands read anywhere and write only in the working directory, `/tmp`,
   `$TMPDIR` and configured roots. `.git`, `.agents`, `.codex`, `.pi` and `.aws` stay read-only, and
   network access is off. `sandbox-exec` on macOS, or `bwrap` on Linux, is the first process, so no
   shell runs unsandboxed before it.
   A failure is returned to the agent, which can retry with
   `sandbox_permissions: "require_escalated"` and a `justification`.
5. Approval requests go to the reviewer model, or to you. An approved escalation runs outside the
   sandbox. Commands whose every segment matches an `allow` rule also run outside it.

Guardian also replaces `write` and `edit`, and checks each mutation at the absolute path Pi resolved,
so `@`-prefixed and `file://` paths are judged as what they actually write. Writes inside the writable
roots are approved automatically; other paths need approval. A leaf symlink is followed even when its
target is missing, a file with more than one hard link is never written automatically, and parent
directories are created only after the change is allowed. Writes that are approved automatically run
inside the sandbox, so a link swapped in after the check cannot redirect them. Without a usable sandbox,
every command and file change needs approval, except commands an `allow` rule of yours covers: as in
Codex, an allow rule runs its command outside the sandbox on every platform.

## Connector approvals

Every call from Pi's built-in MCP extension (`sourceInfo.path = builtin:mcp`) is classified when
its leaf runs, including tools registered after startup, codemode calls and delegated calls.
Other connector extensions must be declared by exact registered tool name in `config.json`:

```json
{
  "connectors": {
    "readOnly": ["mcp__docs__lookup"],
    "alwaysReview": ["custom_update", "mcp__service__publish"]
  }
}
```

Both lists default to empty and accept up to 1024 exact names each, without patterns. `alwaysReview`
wins over `readOnly` and annotations. Otherwise an MCP call bypasses review only with
`readOnlyHint: true` and no `destructiveHint: true`, or an exact `readOnly` override. Unknown or
non-read-only calls require approval. Core tools and Guardian's shell/file tools keep their existing
gates even when listed in `alwaysReview`; ordinary namespaces and tool-name verbs do not identify connectors. A replacement MCP
extension needs explicit names. Check registered names after server changes: collision suffixes can
change which name identifies a tool. Invalid config retains the last valid declarations; on the first
invalid load, custom declarations are unavailable and only built-in MCP identity is recognized.

The configured reviewer receives the exact arguments, parent transcript and a bounded server-authored
description, which is untrusted evidence. An interactive approval shows the full action JSON. Actions
over 256 KiB are rejected before review, including human review. `never` rejects review-required
connector calls; disabled Guardian bypasses the gate. Model failure uses the existing human fallback,
and no available approval means rejection. Audit write failure also blocks execution. Preflight blocks (identity lookup, `never`, cancellation
before review and size limits) return tool errors without an approval audit entry. Recognized
review-required connector calls clear older replayable shell/file denials before these checks.

A delegation grant grants capability only. The child bridge proxy forwards to one approval at the
actual parent leaf, without reviewing twice. Independent child cancellation prevents execution after
the hook settles, but Pi exposes only the parent operation signal to the hook: an idle-parent review
may continue until completion or timeout. Rejecting an interactive background approval can abort the current parent operation, including
a turn, retry, compaction or branch summary. Child denials count toward the parent turn's denial breaker.

Each mutation adds review latency (up to the review timeout, including retries). In a parallel tool
batch Pi prepares hooks serially before executing approved calls; a later model denial can precede an
earlier approved call's execution. Human rejection or the denial circuit breaker can abort the batch.
Calls are not transactional: denying call 3 does not roll back calls 1–2, and scripts may catch errors
and continue. Existing MCP results and `isError` flags pass through unchanged.

Guardian's connector audit stores tool/call identity, argument byte count, verdict and timing, without
arguments, argument hashes, reviewer free text or context hashes. Safe failure categories distinguish
review timeouts, model/configuration failures and an unavailable interactive user. `/guardian approve` cannot replay
connector payloads; approve in chat and retry, or use a fresh interactive review. Pi's ordinary
transcript and nested-call records can still contain arguments, and the reviewer provider receives
them. Annotations are unverified server claims. This gate cannot contain a malicious server or
host-privileged extension; a later `tool_call` handler can also change arguments after review.

## Linux

On Linux, Guardian runs Codex's sandbox: bubblewrap builds the filesystem view and a seccomp filter
limits the network.

- The filesystem is mounted read-only, the writable roots are bound back writable, and `.git`,
  `.agents`, `.codex`, `.pi` and `.aws` under each of them are bound read-only. A missing one is
  masked with an empty read-only placeholder, so it cannot be created either. Bubblewrap has to create
  that placeholder on the host while the command runs, and Guardian removes it afterwards. Guardian
  shares Codex's placeholder registry under `$TMPDIR`, so Guardian and Codex running in the same
  workspace keep each other's placeholders. Registration requires util-linux `flock` at `/usr/bin/flock`
  or `/bin/flock` and waits at most 10 seconds within the command's timeout and cancellation budget.
  Sandbox detection does not check this dependency; missing `flock` makes preparation fail closed.
  Completion waits up to two seconds for cleanup. Lock contention and helper failures are retried with
  backoff while Pi remains alive, retaining ownership markers until locked cleanup can run. Filesystem
  cleanup errors or process exit can leave markers and placeholders behind; removal is not guaranteed.
- Without network access, the network namespace is unshared and the filter denies every socket
  except Unix sockets, along with `ptrace`, cross-process memory access and io_uring. With network
  access, the filter still denies VM sockets and io_uring.
- Guardian takes the first `bwrap` on `PATH` that the sandbox could not replace, and uses it when its
  help lists `--as-pid-1` and `--perms` (bubblewrap 0.8 or newer). Otherwise it uses the bubblewrap
  bundled with the Codex install on `PATH` (npm, pnpm, bun or the standalone installer) and warns at
  session start. With neither, or when bubblewrap cannot create user namespaces, Guardian warns and
  every command needs approval. WSL1 is not supported; WSL2 is.
- Where the host forbids mounting a fresh `/proc`, as some containers do, commands run without one.
- When Pi starts without `SHLVL` in its environment (from a desktop launcher rather than a terminal),
  bash inside the network-isolated sandbox sources `~/.bashrc` instead of `BASH_ENV`. Codex's filter
  makes `getpeername` fail, which bash reads as having been started by `rshd`. Either file runs only
  inside the sandbox.

Install bubblewrap with your package manager: `sudo apt install bubblewrap` on Ubuntu 24.04 and
later, `sudo pacman -S bubblewrap` on Arch. Ubuntu 22.04 ships bubblewrap 0.6, which is too old, so
Guardian uses Codex's bundled copy there. `/guardian status` names the bubblewrap in use.

When the parent runs Guardian, subagent children load it the way they load hooks, so a child cannot run
what the parent would review, and a child refuses to start if Guardian is missing. A parent without
Guardian starts children without it.

If Guardian itself cannot start, for example because a bundled file is unreadable, it still replaces
`bash`, `write` and `edit` with tools that refuse every call, and blocks review-required built-in MCP
calls. Startup failure cannot load custom connector declarations. It reports the failure at session start.

## Preferences

Guardian reads `~/.pi/agent/guardian/config.json` (under `$PI_CODING_AGENT_DIR` when set) and
rereads it when it changes. A missing file means the defaults below. An invalid file keeps the last
valid settings. With no valid settings yet, built-in shell/file protections use strict defaults and
built-in MCP mutations require approval, but custom connector declarations are unavailable. Unknown
settings are errors.

```json
{
  "enabled": true,
  "approvalPolicy": "on-request",
  "approvalsReviewer": "auto_review",
  "reviewer": { "provider": "openai-codex", "model": "gpt-6-luna~fast", "reasoning": "low" },
  "autoReview": {
    "failureFallback": "user"
  },
  "sandbox": {
    "mode": "workspace-write",
    "networkAccess": false,
    "writableRoots": [],
    "excludeTmpdirEnvVar": false,
    "excludeSlashTmp": false
  }
}
```

| Setting | Codex equivalent | Values |
| --- | --- | --- |
| `approvalPolicy` | `approval_policy` | `on-request` (default): the agent asks when it needs to leave the sandbox. `untrusted` (Codex's value; `unless-trusted` also works): everything not allowed by a rule needs your approval, and a sandbox failure is retried outside the sandbox. `never`: nothing is approved; escalations are rejected. |
| `approvalsReviewer` | `approvals_reviewer` | `auto_review` (default): the reviewer model decides on-request approvals. `user`: you decide every approval. |
| `reviewer` | (model catalog) | Any model in Pi's registry, for example `{"provider": "openai-codex", "model": "gpt-6.1-sol", "reasoning": "medium"}`. For Claude, use `{"provider": "claude-cli", "model": "claude-opus-5-5", "reasoning": "high"}`, which reviews through `claude -p` with `--safe-mode` and read-only tools. `reasoning` is a Pi thinking level. |
| `autoReview.policy` / `policyFile` | `[auto_review] policy` | Replaces the built-in tenant policy (Codex's `policy.md`). |
| `autoReview.extraPolicy` / `extraPolicyFile` | `[auto_review] extra_policy` | Your additional rules, inserted into the policy template's `{{ extra_policy }}` slot. |
| `autoReview.failureFallback` | (none) | `user` (default): when a review times out or fails, you are asked; without a UI it is rejected. `reject`: rejected to the agent, as Codex does. A failed review never approves. |
| `sandbox.mode` | `sandbox_mode` | `workspace-write` (default), `read-only`, or `danger-full-access` (no sandbox). |
| `sandbox.networkAccess` | `[sandbox_workspace_write] network_access` | Network inside the sandbox. |
| `sandbox.writableRoots` | `[sandbox_workspace_write] writable_roots` | Extra absolute paths the sandbox may write. |
| `sandbox.excludeTmpdirEnvVar` / `excludeSlashTmp` | `[sandbox_workspace_write] exclude_tmpdir_env_var` / `exclude_slash_tmp` | Drop `$TMPDIR` or `/tmp` from the writable roots. |

The block above shows the defaults; `policy` and `extraPolicy` are unset by default. Policy text may be
inline (`policy`, `extraPolicy`) or a file (`policyFile`, `extraPolicyFile`), not both. File paths are
relative to the config directory, so a shared file can be symlinked there or referenced by absolute path.
A policy file is reread when `config.json` changes, not when the file itself changes; `/guardian reload`
picks it up.

## Command rules

Rules use Codex's `.rules` syntax and live in `~/.pi/agent/guardian/rules/*.rules`, like
`~/.codex/rules/`:

```python
prefix_rule(
    pattern = ["npm", "run", ["test", "lint"]],
    decision = "allow",            # or "prompt", "forbidden"
    justification = "Project checks are routine.",
    match = ["npm run test"],      # examples validated when the file loads
    not_match = ["npm run deploy"],
)
host_executable(name = "git", paths = ["/usr/bin/git", "/opt/homebrew/bin/git"])
```

When you approve a command with "Yes, and don't ask again for commands that start with …",
Guardian appends that prefix to `rules/default.rules`. The option is only offered for a prefix that
cannot widen a boundary: prefixes that invoke the Railway CLI, wrapper commands such as `env`, `xargs`
and `find`, and Codex's banned suggestions (bare interpreters, `npm run`, `git`, `sudo` and the like)
are never saved. Package runners such as `npm test` are saved as in Codex; the Railway boundary is
checked before rules, so a rule cannot reach it. If a rules file cannot be read or parsed, Guardian
warns and keeps the rules that last loaded; when none have loaded yet, only Guardian's own rules apply
until the file is fixed.

Guardian parses the `prefix_rule`, `host_executable` and `network_rule` calls that Codex's own rules
files use, with string and list literals. Codex evaluates these files as Starlark, so rules built from
variables or expressions are rejected here.

## Shared rules: Railway

The boundary lives in code, in `extensions/guardian/railway.ts`, because a rules file inside a
writable checkout could be edited, deleted, or left unparsed. It is checked before rules, settings and
review, and it still applies when Guardian is disabled or the sandbox is off.

A destructive Railway operation is refused outright. That covers the CLI by any name or path
(`railway`, `/opt/homebrew/bin/railway`, `./railway`, `~/.railway/bin/railway`), flags before the
subcommand (`railway --json delete`), package runners (`npx @railway/cli delete`, `bunx railway down`),
wrappers (`command`, `exec`, `nohup`, `timeout`, `nice`, `xargs`, `sudo`, `env`, `eval`), and literal
commands hidden in control flow, substitutions or nested shells. Destructive verbs include `delete`,
`down`, `destroy`, `remove`, `rm`, `reset`, `wipe`, `prune`, `restore` and `drop`, against any target
including volumes, buckets, databases, environments, services and projects.

Any script that names Railway next to a destructive word is also refused, even when the mention is only
text, such as `rm -f railway.json` or a commit message that says "remove railway config". That catches
forms static parsing cannot follow (`eval`, `find -exec`, `python -c`) and Railway's API mutations such
as `volumeDelete`; for a boundary this absolute, a false refusal beats a miss. Reword the command, or
use the write tool, when it trips on harmless text. Package specs with versions (`@railway/cli@4.0.0`)
and Railway's data hosts (`backboard.railway.com`, `*.rlwy.net`, `*.railway.internal`) count as naming
Railway. Other Railway commands that can reach data (`connect`, `run`, `variables`, `ssh`, the volume,
database, environment, service and project subcommands, and any command calling a Railway data host) are
always reviewed. `railway status`, `logs` and `whoami` are untouched.

A database command (`psql`, `mysql`, `mongosh`, `redis-cli`, `pg_restore` and other clients, and the
wipe tools `dropdb`, `prisma migrate reset` and `rails db:drop`) whose target Guardian cannot prove local
runs only when all of its SQL is visible and none of it is destructive. Otherwise it is refused outright,
like the Railway boundary, because the target may be a Railway database: `psql "$DATABASE_URL" -c 'DROP
TABLE users'` against a remote or unknown database is refused, and so is SQL Guardian cannot see, from
`-f`, standard input or `\i`, since it could be destructive. Local targets are `localhost`, `127.0.0.1`,
`::1`, a Unix socket and a SQLite file.

Guardian evaluates the script with the bash grammar: each command's arguments as bash passes them, with
variables such as `$DATABASE_URL` taken from Pi's environment only where bash would expand them. It reads
each client's options the way the client does, including clusters such as `-qc`; an option it does not
know counts as hidden SQL. Hosts come from host and socket options, connection strings and the variables
a client reads (`PGHOST`, and `PGHOSTADDR`, which libpq always uses), with every host of a multi-host URI
or list counted after libpq's percent-decoding. A client that finds its server by default (`psql`
without a host, `redis-cli`, `sqlite3`) counts as local. A target is unproven when a statement moves the
session (`\connect`, `\!`, mysql's `connect`, MongoDB's `connect()`), when a `service=` names its host in a
file Guardian does not read, or when a startup file could connect elsewhere first: `psql` without `-X`
and `mongosh` without `--norc` count as unproven when `~/.psqlrc` or `~/.mongoshrc.js` exists, when the
command changes `HOME` or `PSQLRC`, or when it writes files and so could create one. `mysql` needs an
explicit host, since its option files can name one; Prisma and Rails need a local `DATABASE_URL`, since
their `.env` and `database.yml` are not read.

A script that involves a database client may contain only commands Guardian can judge completely: client
invocations, read-only tools used with options that keep them read-only (`rg` and `grep` without `--pre`
or `-z`, `sed -n '1,10p'`, `git log`, `diff`, `commit` and similar without `-c` or `--exec`, `cat`,
`head`, package installs), neutral builtins (`cd`, `set -e`), and the wrappers `sudo`, `env`, `timeout`,
`nice`, `nohup` and `command` with their documented options. Anything else in such a script is refused,
along with a script Guardian cannot evaluate exactly: nested shells, `eval`, `source`, `trap`, `ssh`,
`docker exec`, `doppler run`, `xargs`, control flow and substitutions. Run those as separate commands,
name a local host explicitly, or run them yourself outside Pi.

`personal-settings/guardian/rules/railway.rules` keeps the same denials as `.rules` data for defence in
depth, and the reviewer additionally gets an absolute deny on destructive Railway database and storage
operations through any other route, from `personal-settings/guardian/extra-policy.md`. Guardian adds its
built-in copy of that text whenever the file does not carry it verbatim. A review is not a hard boundary for routes that never name Railway, such as a database
client reading credentials from the environment; those depend on the reviewer's judgement.

Never test any of this by running Railway commands. `extensions/guardian/railway.test.ts` evaluates the
decision function and the bash tool directly.

## Load order

The default reviewer `gpt-6-luna~fast` is a virtual model Fast mode registers. Guardian resolves the
reviewer when a review starts, not at load, and falls back to the plain `gpt-6-luna` when the `~fast`
alias is unavailable — so a session without Fast mode, such as a subagent child, still reviews. Guardian
still sits after Fast mode in `package.json` so the alias resolves when both are present.

## Commands and status

- `/guardian` (or `/guardian toggle`) turns Guardian off or back on for this session; `/guardian off` and
  `/guardian on` set it explicitly. Off works like `"enabled": false`: commands and file changes run
  without the sandbox or review, connector calls run without review, and the agent gets no permission instructions. The Railway and database
  boundaries still apply. The switch lasts until the session ends, so `/reload`, `/new`, `/resume`,
  `/fork` and restarting Pi return to `config.json`, which it never changes. Other Pi sessions and
  subagent children keep following `config.json`.
- `/guardian status` shows the effective settings and file locations.
- `/guardian approve` approves the most recently denied shell/file action. Recognized review-required
  connector calls clear replayable approvals, even when allowed or blocked before review. Connector
  approval requires chat authorization or a fresh interactive review. For shell/file actions the command
  records Codex's trusted manual approval message, so the reviewer can allow that exact action on retry.
- `/guardian reload` rereads the rules and config.
- `/guardian audit` shows the current session branch's recent approval decisions.

The footer's top-right indicator shows `Auto: on · Luna low`, `Auto: on · Opus high`,
`Auto: on · you review` or `Auto: off` (also while `/guardian off` is in effect), and adds
`· network` or `· no sandbox` when they apply.
While a review runs, the status line shows "Reviewing approval request…".

Guardian replaces Auto Permissions. If both are loaded, commands are reviewed twice and Guardian
warns at session start.

## Approval history

`/guardian audit` shows the last 20 approval decisions on the current session branch and the session
file containing the full history. Guardian saves decisions as `guardian-approval-decision` custom
entries in Pi's session JSONL. These entries do not enter the agent's or reviewer's conversation.

Each entry records the action, verdict, automatic reviewer, human or policy decider, rationale,
timestamp and handling latency. Automatic decisions also record the configured reviewer and its
risk and authorization assessment. A failed review and a subsequent human decision have separate
entries with the same request ID. `/guardian approve` records the human's approval of the previously
denied action, with its immediate command-handling latency rather than the time since the denial.
Human entries distinguish approval, a requested standing rule, rejection and dismissal. Requested
rules are not proof that the subsequent rule write succeeded. If a decision cannot be saved, the
operation does not proceed. These are permission decisions, not a command-execution log.

Actions up to 256 KiB are stored exactly. Larger actions have a bounded preview, original byte count
and `actionTruncated: true`; the original tool call remains in the referenced transcript. The audit
view bounds command and reason previews and reports when older entries were omitted. Full records
remain in the session file. Hard policy refusals before an approval request still appear as tool
errors; this history covers approval requests, including their internal policy rejections.

The session ID and leaf entry identify the conversation at the decision. Automatic reviews save
separate SHA-256 hashes for the system policy, AGENTS instructions, planned action and retained
transcript with trusted answers. These hashes omit the session ID, date and timezone, so the components
can be compared across sessions. Later read-only tool results are not hashed. Identical hashes do not
make model verdicts deterministic. Compare the recorded rationale and transcript before attributing
a disagreement to inconsistent policy.

### Offline approval statistics

From the checkout, read explicit JSONL files or use `-` once for stdin:

```bash
node --import tsx extensions/guardian/audit-stats.ts approvals.jsonl
node --import tsx extensions/guardian/audit-stats.ts --json approvals.jsonl other-approvals.jsonl
node --import tsx extensions/guardian/audit-stats.ts --json - < approvals.jsonl
```

Nothing is discovered automatically. The input is Pi's actual custom-entry envelope:
`type: "custom"`, `customType: "guardian-approval-decision"`, and object `data` with `version: 1`.
Bare payloads are not accepted. Extra fields are tolerated; unsupported or missing versions are
excluded explicitly. Output contains aggregate counts and static labels only, including on errors.
After establishing session provenance, preserve the envelope when filtering metadata locally:

```bash
jq -c 'select(.type == "custom" and .customType == "guardian-approval-decision")' verified-session.jsonl |
  node --import tsx extensions/guardian/audit-stats.ts --json -
```

`records.audit` counts recognized envelopes within the retained scan prefix, including schema exclusions and duplicates;
`records.distinct` counts retained decisions. Identical canonical audit data with a request ID is
deduplicated across inputs. Distinct decisions sharing an ID remain separate; missing IDs are
unkeyed. Request outcome flags overlap, so their sum can exceed the unique-request count.
Additional decisions can be fallbacks or manual approvals. Runtime retries cannot be measured
from this schema, and separate request IDs are never collapsed because their actions match.

Timing summaries give valid sample count, exclusions, total and exact nearest-rank p50/p90/p95
(`ceil(p*n/100)`). Empty percentiles are `null`; totals beyond JavaScript's safe integer range are
decimal strings. Missing, nonnumeric, nonfinite, negative and noninteger/unsafe durations are
excluded from timing only. Use `byPhase.auto_review` for reviewer handling and `byPhase.user_prompt`
for prompt handling; manual approvals and unknown user choices have separate groups. Other
breakdowns mix phases. Operation counts count distinct decisions, so a fallback or manual approval
can add another record in the same class. Duration sums are handling intervals, not elapsed session time.

Operation classes describe structured write/edit tools or literal command families: Git, package
manager, Node, network client and filesystem utility. Multiple plain shell commands are `compound`;
unsupported syntax, wrappers, executable paths and truncated actions are `unknown`. The full recorded
script is classified, including any command prefix. These categories do not explain escalation
causes, prove execution or authorize changing permission rules.

The scanner bounds each line to 1 MiB, total admitted input to 64 MiB, retained distinct records to
100,000 and sources to 128. Shell scripts above 32 KiB are not parsed. Parser throws disable further
shell classification for that scan; both cases have explicit classification exclusions and mark the
report incomplete while preserving decision counts/timings. Module callers can lower these limits.
Oversized or malformed lines are
discarded; exclusions and early stops mark `complete: false`. Exit codes: **0** complete scan,
**1** usage/I/O/internal error, **2** report produced with exclusions or a resource stop. I/O failures
also produce an incomplete aggregate when possible. Invalid timings alone do not stop the scan.

For real measurements, select only sessions whose header proves this repository/worktree's cwd;
directory-name encoding alone is insufficient. Forks may contain inherited entries from another
cwd, so verify audit provenance too. Extract approval custom-entry metadata locally and send only
aggregate output to a model. Keep machine-specific results in ignored scratch. Explicit files can
include abandoned branches, and missing/unsaved decisions or sessions without persistence are absent.
Small populations limit percentile interpretation. See [ADR 027](adr/027-guardian-offline-audit-stats.md).

## Understanding sandbox failures

Guardian preserves the original failure and exit status. Failed network requests, and authentication
errors from recognized network clients, receive a hint when network access is disabled. Failures that
match the sandbox-denial heuristic receive an access hint. The hints appear when a failure is returned;
an `unless-trusted` retry still returns its own result. A hint is diagnostic context, not proof that
the sandbox caused the error, and it does not change approval or retry decisions. With approval policy
`never`, hints state that escalation is disabled.

An ignored scratch directory may contain user work, so being ignored does not bypass review.

Git writes such as `add`, `fetch`, `checkout` and `commit` need escalation under the default policy
because `.git` is read-only. Keeping only hooks and config read-only would broaden the existing
metadata boundary; this implementation retains it. An `allow` command rule is not a confined Git
exception: it runs the matching command outside the sandbox.
Reducing approval traffic safely needs an operation-specific Git runner that also confines hooks,
config-selected helpers, alternate repository paths and linked worktrees.

On macOS the policy already allows process information for processes in the same sandbox. Broad
process enumeration is not enabled. The Pi host and processes started outside that sandbox are
outside this permission's scope. A native macOS test targets `ps -p <pid>` for that invocation's shell
and child. It has not run on this Linux machine, so runtime `ps` compatibility remains unverified.
Linux runs verify the generated policy only.
