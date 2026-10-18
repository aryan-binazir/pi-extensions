# Guardian

[Back to README](../README.md)

Guardian ports Codex's approval stack to Pi: exec-policy rules, the Seatbelt sandbox on macOS and
the bubblewrap and seccomp sandbox on Linux, permission instructions for the agent, and the Guardian
auto-reviewer. Our inspiration from this code comes from there. The source is
[openai/codex](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897)
(Apache-2.0; see [third-party notices](licenses/README.md)). [ADR 025](adr/025-guardian.md)
records where it departs from Codex.

## How a command is decided

Guardian replaces Pi's `bash` tool and gates `write` and `edit`.

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

## Linux

On Linux, Guardian runs Codex's sandbox: bubblewrap builds the filesystem view and a seccomp filter
limits the network.

- The filesystem is mounted read-only, the writable roots are bound back writable, and `.git`,
  `.agents`, `.codex`, `.pi` and `.aws` under each of them are bound read-only. A missing one is
  masked with an empty read-only placeholder, so it cannot be created either. Bubblewrap has to create
  that placeholder on the host while the command runs, and Guardian removes it afterwards. Guardian
  shares Codex's placeholder registry under `$TMPDIR`, so Guardian and Codex running in the same
  workspace keep each other's placeholders.
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
`bash`, `write` and `edit` with tools that refuse every call and says why at session start, so Pi never
falls back to its unguarded tools.

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
variables such as `$DATABASE_URL` taken from Pi's environment only where bash would expand them, and
nested shells and `eval` evaluated again. It reads each client's options the way the client does,
including clusters such as `-qc`; an option it does not know counts as hidden SQL. Hosts come from host
and socket options, connection strings and the variables a tool reads (`PGHOST`, and `PGHOSTADDR`, which
libpq always uses), with every host of a multi-host URI or list counted after libpq's percent-decoding.
A client that finds its server by default (`psql` without a host, `redis-cli`, `sqlite3`) counts as local.

It cannot prove a target local when the script cannot be evaluated exactly (control flow, substitutions
anywhere including redirections, an unset variable, a wrapper option it does not know, `env -S`), when an
earlier command changes what later ones see (`source .env`, `read`, `set -a`, `set --`, `exec <file`),
when a client named in one command's arguments is fed to another (`echo "psql …" | at now`), when the client
runs through `ssh`, `kubectl`, `docker exec` or another remote or container prefix, or through a runner
that can inject credentials (`doppler run`, `op run`, `aws-vault exec`, `dotenv` and similar), when
`xargs` or `find -exec` supply its arguments, when a statement moves the session
(`\connect`, `\!`, MongoDB's `connect()`), or when a `service=` names its host in a file Guardian does
not read. A startup file can connect elsewhere before the statements run, so `psql` without `-X` and
`mongosh` without `--norc` count as unproven when `~/.psqlrc` or `~/.mongoshrc.js` exists, when the
command changes `HOME` or `PSQLRC`, or when it writes files and so could create one. `mysql` needs an
explicit host, since its option files can name one; Prisma and Rails need a local `DATABASE_URL`, since
their `.env` and `database.yml` are not read. Name a local host explicitly, or run such commands yourself
outside Pi.

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

- `/guardian` shows the effective settings and file locations.
- `/guardian approve` approves the most recently denied action. It records Codex's trusted manual
  approval message in the session, so the reviewer can allow that exact action when the agent retries.
- `/guardian reload` rereads the rules and config.

The footer's top-right indicator shows `Auto: on · Luna low`, `Auto: on · Opus high`,
`Auto: on · you review` or `Auto: off`, and adds `· network` or `· no sandbox` when they apply.
While a review runs, the status line shows "Reviewing approval request…".

Guardian replaces Auto Permissions. If both are loaded, commands are reviewed twice and Guardian
warns at session start.
