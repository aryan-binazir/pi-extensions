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
directories are created only after the change is allowed. Writes that are approved automatically run
inside Seatbelt, so a link swapped in after the check cannot redirect them. Without Seatbelt (any platform
other than macOS), every command and file change needs approval, except commands an `allow` rule of
yours covers: as in Codex, an allow rule runs its command outside the sandbox on every platform.

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
Guardian appends that prefix to `rules/default.rules`, unless the prefix would widen a boundary: Railway
programs, package runners such as `npx`, wrapper commands such as `env`, `xargs` and `find`, and Codex's
banned suggestions are never persisted. If a rules file cannot be read or parsed, all of your rules are
skipped with a warning — including any `forbidden` rules of your own — and Guardian's own rules still
apply. Fix the file to get your rules back.

Guardian parses the `prefix_rule`, `host_executable` and `network_rule` calls that Codex's own rules
files use, with string and list literals. Codex evaluates these files as Starlark, so rules built from
variables or expressions are rejected here.

## Shared rules: Railway

`personal-settings/guardian/rules/railway.rules` and `personal-settings/guardian/extra-policy.md`
The boundary itself lives in code, in `extensions/guardian/railway.ts`, because a rules file inside a
writable checkout could be edited, deleted, or left unparsed. It is checked before rules, settings and
review, and it still applies when Guardian is disabled or the sandbox is off.

A destructive Railway operation is refused outright. That covers the CLI by any name or path
(`railway`, `/opt/homebrew/bin/railway`, `./railway`, `~/.railway/bin/railway`), flags before the
subcommand (`railway --json delete`), package runners (`npx @railway/cli delete`, `bunx railway down`),
wrappers (`command`, `exec`, `nohup`, `timeout`, `nice`, `xargs`, `sudo`, `env`, `eval`), and literal
commands hidden in control flow, substitutions or nested shells. Destructive verbs include `delete`,
`down`, `destroy`, `remove`, `rm`, `reset`, `wipe`, `prune`, `restore` and `drop`, against any target
including volumes, buckets, databases, environments, services and projects.

A script that cannot be parsed statically but names Railway next to a destructive verb is also refused,
even if the mention is only text: for a boundary this absolute, a false refusal beats a miss. Other
Railway commands that can reach data (`connect`, `run`, `variables`, `ssh`, and the volume, database,
environment, service and project subcommands) are always reviewed. `railway status`, `logs` and
`whoami` are untouched.

`personal-settings/guardian/rules/railway.rules` keeps the same denials as `.rules` data for defence in
depth, and the reviewer additionally gets an absolute deny on destructive Railway database and storage
operations through any other route — falling back to built-in text if the bundled policy file is
unreadable. A review is not a hard boundary for routes that never name Railway, such as a database
client reading credentials from the environment; those depend on the reviewer's judgement.

Never test any of this by running Railway commands. `extensions/guardian/railway.test.ts` evaluates the
decision function and the bash tool directly.

## Load order

The default reviewer `gpt-6-luna~fast` is a virtual model Fast mode registers. Guardian resolves the
reviewer when a review starts, not at load, and falls back to the plain `gpt-6-luna` when the `~fast`
alias is unavailable — so a session without Fast mode, such as a subagent child, still reviews. Guardian
still sits after Fast mode in `package.json` so the alias resolves when both are present.

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
