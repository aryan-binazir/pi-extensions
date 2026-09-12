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
scores; navigating into an enabled branch cannot silently approve a changed policy.

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
On resuming an enabled session, user-owned global settings are loaded afresh.

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
failures block enabled review. Config is limited to 8 KiB; preferences to 32 KiB.
Missing default files mean defaults/no extra preferences; an explicitly selected
missing policy file is an error.

Pi supplies provider authentication, OAuth refresh, headers, environment and base
URL. Luna must be present in the model catalog. The blocking model can be addressed
through the provider even when hidden from the model picker. Credentials are never
copied into Sentinel settings, child snapshots, or decision logs.

## How review works

1. Each proposed LLM tool call starts an asynchronous trajectory classification.
   Luna predicts current and upcoming risk and emits `high` or `low`.
2. A previous `low` score can release a call only with unchanged user authority,
   steering instructions, policy, session and worktree, within two tool calls.
3. Cold, high, missing, stale, failed or incomplete scores require a separate
   blocking assessment. Blocking reviews never populate the trajectory cache.
4. The reviewer can investigate with `read`, `grep`, `find` and `ls` only: no shell,
   network, mutation or extension tools. Reads are UTF-8 regular files up to 2 MiB.
5. Invalid decisions, cancellation, timeouts and mid-review authorization/policy
   changes fail closed. Where available, denials explain the reviewer's rationale.

Four classifier requests maximum; superseded work is cancelled. Late results
cannot overwrite newer scores. The first nonempty output delta decides; malformed
or split labels require blocking review. Requests use SSE and abort after the first
classification instead of retaining background sockets. Transport failures get one
bounded retry within the same decision timeout; malformed decisions do not. There
is no circuit breaker or silent model substitution. Reviewer JSON may have a prose
or code-fence wrapper, but the extracted object must validate.

Per attempt, blocking review has five model rounds, eight read-only inspections,
and 64K characters of inspection output. Actions over 40K characters skip the fast
classifier and go to blocking review **with full arguments**; the hard blocking-review
action limit is 256K characters. No truncated action is approved as if complete.

## Evidence and delegated work

Original user messages survive compaction as authority. Summaries, assistant text,
tool outputs, skill/plugin descriptions and delegation briefs remain untrusted
execution evidence. Host-loaded instructions have a separate budget from user
messages. Only verified questionnaire **answers** carry user input; the model's
questions remain explicitly untrusted, not blanket authorization.

Budgets: 128K characters each for user authority and host instructions; the newest
20 non-user entries, 16K characters per entry and 64K total; four images/4 MiB of
encoded data, preferring recent screenshots. Truncation prevents cached approvals
and is surfaced in status. Child snapshots omit image payloads and explicitly mark
visual user authority as incomplete rather than claiming to have transmitted it.

When Sentinel is enabled, the bundled direct-subagent and workflow launch paths
inject the guard even with normal extension discovery disabled. A private live
snapshot carries root user authority and confirmed policy identity. A child brief
is not independent user approval. Children reread root authority before each call;
confirmed policy updates propagate. Model/settings changes require restarting
existing children. Parent shutdown removes the snapshot after child shutdown.

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
