# Sentinel

Adaptive tool review for Pi: a fast Luna trajectory classifier, a separate blocking
reviewer, and your standing preferences. **Auto review is off by default in new chats.**
Loading the extension alone does not classify or block tools, read its config, or
make model requests.

## Session controls

- `/auto` or `/sentinel`: status, effective config, and any incomplete-evidence reasons.
- `/auto on`: review the complete settings/preferences, confirm, and enable this session.
- `/auto off`: stop reviewing parent tools; new children are unguarded. Already-running
  guarded children retain their guard until they finish.
- `/sentinel reload`: review and confirm changed settings/preferences, enabling auto review.

Changes require an idle interactive parent session. Mode is recorded in the current
session branch, restored on resume, and defaults off when there is no saved entry.
Children inheriting an enabled guard cannot turn it off. Session navigation resets
scores. The confirmed settings/preferences fingerprint is persisted with enabled
mode, so resume, extension reload, and branch navigation cannot silently approve
changed files. Older enabled entries without that fingerprint require confirmation.
A failed enable attempt blocks the current session but saves no approval; status shows
both current and persisted modes. Resume restores the last successful mode, possibly off.

## Your preferences file

Write standing preferences in **`~/.pi/agent/sentinel-policy.md`** (or under
`PI_CODING_AGENT_DIR`). Both the classifier and the blocking reviewer receive it.
For example:

```markdown
# My standing preferences
- Routine local edits and tests are authorized within the task's scope.
- Do not push to a default branch unless I explicitly request that push.
- Never delete uncommitted work without asking about the exact target.
- Do not send private source to third-party services unless I approve the
  specific data and destination.
```

These are examples, not preinstalled permissions. Be precise about targets,
destinations and side effects. Do not put secrets in the file. Preferences and
relevant conversation/tool evidence are sent to the configured review providers.

While auto review is enabled, file changes immediately prevent further approvals
until `/sentinel reload` confirms the new contents. An agent edit cannot silently
become trusted authorization. No repository-local config overrides this user file.
Resume rereads global settings and checks the saved confirmation. Recognized built-in
`write`/`edit` calls targeting policy, session/approval records, provider settings or
guard code are blocked. Opaque commands have a bounded control-path scan; uncertainty
or scan exhaustion forces fresh review. File-write payloads are not executable commands.
Use `/auto off` for explicit maintenance, then `/auto on` to confirm.

Optional **`~/.pi/agent/sentinel.json`** settings (all fields optional):

```json
{
  "classifier": "openai-codex/gpt-5.6-luna",
  "reviewer": "openai-codex/codex-auto-review",
  "maxToolCallLag": 2,
  "timeoutMs": 60000
}
```

An optional `policyFile` selects an absolute path; omitting it derives the default
from Pi's actual agent directory. Lag is 0–2 and timeout is 100–300000 milliseconds.
Unknown keys, invalid JSON, symlinks, non-regular files, invalid UTF-8 and read
failures block enabled review. Invisible terminal/bidirectional controls in preferences
are rejected so they cannot conceal policy text during confirmation. Config is
limited to 8 KiB; preferences to 32 KiB.
Missing default files mean defaults/no extra preferences. The default policy path
stays optional even when selected explicitly; a missing non-default path is an error.
The confirmation dialog displays `(none)` when there are no standing preferences.

Pi supplies provider authentication, OAuth refresh, headers, environment and base
URL. Luna must be present in the model catalog. The blocking model can be addressed
through the provider even when hidden from the model picker, using that provider's
Luna transport metadata without changing the requested model ID. Register an explicit
model definition if its endpoint/capabilities differ. Provider credentials are never
copied into Sentinel settings, child snapshots, or decision logs.

## How review works

1. Each eligible LLM tool call starts an asynchronous trajectory classification.
   Luna predicts current and upcoming risk and emits `high` or `low`.
2. A previous `low` score can release a call only with unchanged user authority,
   steering instructions, policy, session and worktree, within two tool calls.
3. Cold, high, missing, stale, failed or incomplete scores require a separate
   blocking assessment. Blocking reviews never populate the trajectory cache.
4. The reviewer can investigate with `read`, `grep`, `find` and `ls` only: no shell,
   network, mutation or extension tools. Reads are UTF-8 regular files up to 2 MiB.
   Search requires an already-installed `rg` and `fd`/`fdfind` in Pi's bin directory
   or PATH; missing dependencies fail without downloading/installing anything.
   Search subprocesses use fixed read-only arguments, bounded output and cancellation.
   Grep skips files reported larger than 2 MiB and reports that limitation.
5. Invalid decisions, cancellation, timeouts and mid-review authorization/policy
   changes fail closed. Where available, denials explain the reviewer's rationale.

Four classifier requests maximum; superseded work is cancelled. Late results
cannot overwrite newer scores. The first nonempty output delta decides; malformed
or split labels require blocking review. Requests use SSE and abort after the first
classification instead of retaining background sockets. Transport failures get one
bounded retry within the same decision timeout; malformed decisions do not. There
is no circuit breaker or silent model substitution. Reviewer JSON must be a bare
object or a complete code-fenced object; narrative/example JSON is not an approval.

Per attempt, blocking review has five model rounds, eight read-only inspections,
and 64K characters of inspection output. Actions over 40K characters skip the fast
classifier and go to blocking review **with full arguments**; the hard blocking-review
action limit is 256K characters. No truncated action is approved as if complete.

## Evidence and delegated work

Original interactive/RPC input is captured **before** skill/template expansion and
retained as separate session metadata when auto is enabled. Before first enablement,
that capture is bounded in-memory only. Older/unobserved user-role messages are not
proof of user origin; restate the task if its original input is unavailable. Expanded
skills/templates, extension custom messages, summaries, tool output and delegation
briefs are untrusted evidence. New custom-message steering invalidates cached scores.

Canonical global user instructions, or context files in an explicitly trusted project,
have a separate authority budget. Other repository instructions and unsourced prompt
overrides stay untrusted. No context file can manufacture a direct user's approval.
Questionnaire authority contains only the displayed selected **label** or custom user
text, with a numeric question index—not hidden option values or textual IDs. Questions
and option metadata remain untrusted, including legacy unsanitized answer entries.

Budgets: 128K characters each for user authority and host instructions; the newest
20 execution/expanded entries, 65,536 characters per entry and 196,608 total; four
images/4 MiB of encoded data. User-provided visual authority gets slots before recent
tool screenshots. Count and aggregate byte limits both trim the oldest execution
history; this rolling-window trimming is explicit in the evidence and does not disable
reuse. Truncation within an included entry or user authority prevents cached approvals
and is surfaced in status. Incomplete evidence goes directly to blocking review without
paying for an unusable classifier request. An oversized original-user history—or a
single paste beyond the 128K capture limit—remains incomplete; start a new session with
concise scope rather than silently discarding earlier restrictions. Child snapshots omit image payloads and explicitly mark
visual user authority as incomplete rather than claiming to have transmitted it.

When Sentinel is enabled, the bundled direct-subagent and workflow launch paths
inject the guard **last**, even with normal extension discovery disabled. A private live
snapshot carries root user authority and confirmed policy identity. A child brief
is not independent user approval. Its initial scope is retained separately from the
rolling execution window (128K character budget); missing/truncated scope is incomplete.
Children reread root authority before each call;
confirmed policy updates propagate. Model/settings changes require restarting
existing children. If files change while the parent is off, guarded children block;
the parent can confirm with `/sentinel reload`, then turn off again. Normal parent
shutdown removes the snapshot after child shutdown. SIGKILL can leave a private
snapshot in the OS temporary directory; never remove another live parent's snapshot.

## Boundaries

This is adaptive review, **not an OS sandbox or a per-action safety proof**. A prior
low score can approve a different action while its classification is running. Lag
0 disables reuse of earlier-action scores and requires blocking review.

Coverage is top-level LLM tool calls, including custom/MCP wrapper calls. User shell
commands, arbitrary trusted extension JavaScript, and subprocesses launched outside
the bundled subagent path are outside this guard. A submitted MCP script is reviewed
as a whole, not at each hidden internal operation. Reviewers share host read access.
No protection is claimed against malicious same-user code changing Sentinel itself.

Keep Sentinel last in extension load order: later trusted hooks can change arguments
after review. No encrypted parent-context reuse, special billing endpoint, or model
calibration guarantee for substitute models is provided. Nested review usage is
not added to Pi's primary-model footer totals; provider billing still applies.

Decision entries retain only tool name, outcome, routing source and a bounded reason.
Scores, prompts, policy text and inspected file contents are not persisted in those
entries. Tests run with synthetic providers and need no credentials:

```sh
node --import tsx --test extensions/sentinel/*.test.ts
```

Third-party prompt assets and their required license/attribution are kept separately
in [`upstream/`](upstream/). The execution-environment and provenance rules are
adapted at runtime in `prompts.ts`.
