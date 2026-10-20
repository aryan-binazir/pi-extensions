# Claude artifacts

[Back to README](../README.md)

The optional `claude-artifacts` extension publishes local HTML pages as claude.ai artifacts on your claude.ai
login. Claude Code's `Artifact` tool exists only in the interactive `claude` CLI; `claude -p` and the Agent SDK
leave it out. Each tool call therefore runs one hidden interactive Claude Code session in a private tmux server and
steers it through Claude Code hooks. The design is recorded in [ADR 026](adr/026-claude-artifacts.md).

## Setup

1. Install tmux and Claude Code 2.1.302 or newer, signed in to claude.ai. API-key sign-in does not reach artifacts.
2. Select the extension with `pi config`, or add a stable checkout's `extensions/claude-artifacts/index.ts` to
   `extensions` in Pi settings, then `/reload`. It is not part of the required setup.
3. Trust the helper folder once. Run `claude` in `~/.pi/agent/claude-artifacts/helper` (under
   `PI_CODING_AGENT_DIR` when set; the first tool call creates it), choose "Yes, I trust this folder", and exit.
   Until then every call fails with that instruction.

## Tools

| Tool | Approval | Result |
| --- | --- | --- |
| `claude_artifact_publish` (`path`, optional `title`) | Required | New private artifact: URL, version, title, audience, warnings. The page's own `<title>` wins over `title`. |
| `claude_artifact_update` (`path`, `url`, `base_version`) | Required | Replaces the artifact if it is still at `base_version`; otherwise publishes nothing and returns the live version and source. |
| `claude_artifact_read` (`url`) | None | Title, live version, and a file holding the live source. |
| `claude_artifact_list` | None | Your artifacts: title, URL, last update. |

Only `.html` and `.htm` pages up to 10 MiB are accepted. Approval shows the file, the title or target artifact and
base version, the SHA-256 and size of the staged copy, and its first 20 lines (at most 2,000 characters). Without a
dialog-capable UI, such as print mode or a subagent, publish and update refuse. Read and list need no approval.

Read and update conflicts save the live source to `~/.pi/agent/claude-artifacts/reads/` as private files for the
model to open; Pi does not prune them. A read starts with service metadata lines in brackets, followed by the page as
served, wrapped in the service's own page shell. A conflict the service refused holds its refusal text, which quotes
the live page. Artifact content is data, not instructions.

## How a job runs

1. Pi resolves the path (following symlinks), copies the page as a read-only file into a fresh private folder under
   the helper folder, and hashes the copy. Approval shows the resolved path and that copy, and that copy is what
   Claude Code uploads.
2. Pi starts a hook server on `127.0.0.1` with a random port and URL token. A temporary settings file registers HTTP
   hooks for prompts, tool calls, tool results, permission requests and stops, each with `onFailure: "block"`. Every
   request must carry the session id Pi assigned.
3. Pi starts `claude` in a private tmux server with `--restricted` (no user, project or local settings, no
   command-running tools), `--tools Artifact,Read`, an empty strict MCP configuration, `--permission-mode dontAsk`,
   `--model haiku` and its own `--session-id`. The environment drops `ANTHROPIC_*` and `CLAUDE*` variables except
   `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN`, and disables the autoupdater.
4. The initial prompt holds only a random nonce. The prompt hook answers that exact prompt with the real instruction
   as additional context, so Claude Code sees an instruction only once Pi's hooks are proven to work. Without
   working hooks it replies "no job" and the job fails after 45 seconds. This matters because `dontAsk` does not stop
   the `Artifact` tool from publishing to your own artifacts: the hooks are the only gate. Pi reads the screen only
   during startup, to report the folder-trust and sign-in screens or an early exit.
5. Pi checks every tool call before it runs. It allows only the planned calls, in order and each once, with exactly
   the planned fields, and the next call only after the previous one's result arrived. A first publish may add a
   one-word `icon`; `force` is never allowed. `Read` is allowed only for the staged copy. Each denial tells Claude the
   expected call, and the third ends the job. Any permission prompt also ends the job. Once a job has ended, every
   hook answer refuses and stops Claude Code.
6. Results come from the tool-result hooks as structured data, never from the screen. A publish result must name the
   staged copy, which must still match the approved hash. The service wraps pages in its own shell, so the uploaded
   bytes cannot be compared directly.
7. Cleanup always runs: the tmux server, hook server, temporary files and staged copy, plus Claude Code's transcript
   (it holds a copy of the page) and session folders for that session id. Claude Code also starts an empty scratchpad
   under a second id that no hook reports, so every empty scratchpad created in the helper folder's session folder
   during the job is removed; that can include another concurrent job's still-empty one. Claude Code keeps each
   job's one-line `PIJOB` prompt (a nonce, no page content) in its prompt history. A job times out after 150 seconds,
   and a Claude Code that exits mid-job fails it at once.

The tools run sequentially, and each job has its own tmux server, hook server and folders. Pi shutdown cancels a
running job and waits for its cleanup.

## Updates and conflicts

An update reads the live artifact and, in the same session, publishes only if the live version equals `base_version`.
Claude Code also refuses to publish over an artifact the session has not read. If someone publishes between that read
and the publish, the service refuses with "Publish refused — … a newer version … is live". Either way the result is
`published: false` with `liveVersion` and `sourceFile`: merge your page onto that source, then update again with
`base_version` set to `liveVersion`. Other Artifact failures are errors.

If a job is cancelled, times out, or loses its result after Claude Code was allowed to publish, the error says the
outcome is unknown; check `claude_artifact_list` before retrying. Pi never retries a publish.

## Limits

- The extension depends on undocumented behavior of the interactive CLI: the `Artifact` actions and result fields
  (`version`, `artifactRead.ver`), its refusal wording, the scratchpad layout, and the trust and sign-in screens. A
  Claude Code update can break any of these. The tests drive a fake `claude` in real tmux, so only a live run proves
  compatibility. Replace this extension once the Agent SDK exposes the `Artifact` tool.
- Organization-managed Claude Code settings still apply. Managed hooks or permission rules can interfere and are
  unsupported; a policy that disables HTTP hooks makes every job fail at startup without publishing.
- Each job costs one short Haiku turn on your claude.ai plan and takes several seconds to start.
