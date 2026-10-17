# Guardian

[Back to README](../README.md)

Guardian ports Codex's approval stack to Pi: exec-policy rules, the macOS Seatbelt sandbox,
permission instructions for the agent, and the Guardian auto-reviewer. Our inspiration from this
code comes from there: [openai/codex](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897)
(Apache-2.0; see [third-party notices](licenses/README.md)). [ADR 025](adr/025-guardian.md)
records where it departs from Codex.

## How a command is decided

Guardian replaces Pi's `bash` tool and gates `write` and `edit`.

1. Rules decide first. A script is split into command segments when it contains only plain words
   joined by `&&`, `||`, `;` or `|`. Each segment is matched against `.rules` prefixes, and the
   strictest decision wins: `forbidden`, then `prompt`, then `allow`.
2. A `forbidden` match is rejected before anything runs. A `prompt` match needs approval.
3. Unmatched commands run inside the sandbox without review, unless they force-remove files
   (`rm -f`, including inside `sudo`, `env`, `trap` and nested shells) or ask to leave the sandbox.
4. The sandbox lets commands read anywhere and write only in the working directory, `/tmp`,
   `$TMPDIR` and configured roots. `.git`, `.agents`, `.codex`, `.pi` and `.aws` stay read-only, and
   network access is off. `sandbox-exec` is the first process, so no shell runs unsandboxed before it.
   A failure is returned to the agent, which can retry with
   `sandbox_permissions: "require_escalated"` and a `justification`.
5. Approval requests go to the reviewer model, or to you. An approved escalation runs outside the
   sandbox. Commands whose every segment matches an `allow` rule also run outside it.

Guardian also replaces `write` and `edit`, and checks each mutation at the absolute path Pi resolved,
so `@`-prefixed and `file://` paths are judged as what they actually write. Writes inside the writable
roots are approved automatically; other paths need approval. A leaf symlink is followed even when its
target is missing, a file with more than one hard link is never written automatically, and parent
directories are created only after the change is allowed. Without Seatbelt (any platform other than
macOS), every command and file change needs approval.

Subagent children load Guardian the way they load hooks, so a child cannot run what the parent would
review. A child refuses to start if Guardian is missing.

## Preferences

Guardian reads `~/.pi/agent/guardian/config.json` (under `$PI_CODING_AGENT_DIR` when set) and
rereads it when it changes. A missing file means the defaults below. An invalid file keeps the last
valid settings, or, when there are none yet, falls back to read-only with approval for everything,
so a typo never widens permissions. Unknown settings are errors.

```json
{
  "enabled": true,
  "approvalPolicy": "on-request",
  "approvalsReviewer": "auto_review",
  "reviewer": { "provider": "openai-codex", "model": "gpt-6-luna~fast", "reasoning": "low" },
  "autoReview": {
    "policyFile": "policy.md",
    "extraPolicyFile": "extra-policy.md",
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
| `approvalPolicy` | `approval_policy` | `on-request` (default): the agent asks when it needs to leave the sandbox. `unless-trusted`: everything not allowed by a rule needs approval, and sandbox failures offer a retry outside it. `never`: nothing is approved; escalations are rejected. |
| `approvalsReviewer` | `approvals_reviewer` | `auto_review` (default): the reviewer model decides on-request approvals. `user`: you decide every approval. |
| `reviewer` | (model catalog) | Any model in Pi's registry, for example `{"provider": "openai-codex", "model": "gpt-6.1-sol", "reasoning": "medium"}`. For Claude, use `{"provider": "claude-cli", "model": "claude-opus-5-5", "reasoning": "high"}`, which reviews through `claude -p` with `--safe-mode` and read-only tools. `reasoning` is a Pi thinking level. |
| `autoReview.policy` / `policyFile` | `[auto_review] policy` | Replaces the built-in tenant policy (Codex's `policy.md`). |
| `autoReview.extraPolicy` / `extraPolicyFile` | `[auto_review] extra_policy` | Your additional rules, inserted into the policy template's `{{ extra_policy }}` slot. |
| `autoReview.failureFallback` | (none) | `user` (default): when a review times out or fails, you are asked; without a UI it is rejected. `reject`: rejected to the agent, as Codex does. A failed review never approves. |
| `sandbox.mode` | `sandbox_mode` | `workspace-write` (default), `read-only`, or `danger-full-access` (no sandbox). |
| `sandbox.networkAccess` | `[sandbox_workspace_write] network_access` | Network inside the sandbox. |
| `sandbox.writableRoots` | `[sandbox_workspace_write] writable_roots` | Extra absolute paths the sandbox may write. |
| `sandbox.excludeTmpdirEnvVar` / `excludeSlashTmp` | same names | Drop `$TMPDIR` or `/tmp` from the writable roots. |

Policy text may be inline (`policy`, `extraPolicy`) or a file (`policyFile`, `extraPolicyFile`),
not both. File paths are relative to the config directory, so a shared file can be symlinked
there or referenced by absolute path.

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
Guardian appends that prefix to `rules/default.rules`. If a rules file cannot be read or parsed, your
rules are skipped with a warning and the bundled rules still apply, so an unreadable file never grants
permission.

Guardian parses the `prefix_rule`, `host_executable` and `network_rule` calls that Codex's own rules
files use, with string and list literals. Codex evaluates these files as Starlark, so rules built from
variables or expressions are rejected here.

## Shared rules: Railway

`personal-settings/guardian/rules/railway.rules` and `personal-settings/guardian/extra-policy.md`
load on every machine and cannot be turned off from config. Destructive Railway CLI commands
(`railway delete`, `down`, and volume, environment, service and database deletion or reset) are
`forbidden`, so no rule, approval or sandbox setting runs them, and the ban still applies when
Guardian is disabled or the sandbox is off. Rules match the command's basename, so an absolute path
is covered, and they also match literal commands hidden in control flow, substitutions, `sudo`, `env`,
`trap` and nested shells. Railway commands that can reach a database (`connect`, `run`, `variables`,
and the volume, database, environment, service and project subcommands) are always reviewed, so the
reviewer can judge the actual statement, client or script. The reviewer also gets an absolute deny on
destructive Railway database and storage operations through any other route.

A reviewer prompt is not a hard boundary for routes with no Railway command in them, such as a
database client reading credentials from the environment: those depend on the review. Never test any
of this by running Railway commands; `extensions/guardian/railway.test.ts` evaluates the rules
directly.

## Commands and status

- `/guardian` shows the effective settings and file locations.
- `/guardian approve` approves the most recently denied action. It records Codex's trusted manual
  approval message in the session, so the reviewer can allow that exact action when the agent retries.
- `/guardian reload` rereads the rules and config.

The footer's top-right indicator shows `Auto: on · Luna low`, `Auto: on · Opus high`,
`Auto: on · you review` or `Auto: off`, and adds `· network` or `· no sandbox` when they apply.
While a review runs, the status line shows "Reviewing approval request…".

Guardian replaces Auto Permissions. If both are loaded, commands are reviewed twice and Guardian
warns at session start.
