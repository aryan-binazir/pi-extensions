# 026: Claude artifacts through a hidden interactive Claude Code

Status: accepted.

## Context

Ar wants Pi to create claude.ai artifacts. Only Claude Code's `Artifact` tool reaches them, and only the
interactive CLI offers it: on 2.1.302, `claude -p --tools Artifact,Read` reports just `Read`, and the Agent SDK
(and therefore the Claude bridge provider) runs the same non-interactive path. The artifact service's HTTP API is
internal and tied to Claude Code's credentials, so calling it directly is not an option. The design follows a
description Ar shared of an equivalent extension in another repository; that code was not available here.

## Decision

`extensions/claude-artifacts/` registers publish, update, read and list tools. Each call runs one hidden interactive
`claude` in a private tmux server and steers it only through HTTP hooks served by Pi. The runner owns publication
staging, approval invocation, read/publish plans, conflict detection, upload verification and cleanup; registration
handles Pi parameters, approval UI and result presentation:

- **The instruction travels through a proven hook.** The initial prompt carries a token and no instruction. The
  `UserPromptSubmit` hook answers that exact prompt with the instruction as `additionalContext`. A spike showed that
  `--permission-mode dontAsk` let a hook-less session read and publish to an owned artifact without asking, so a
  missing hook must mean a missing instruction. Without hooks Claude replied "no job" and called nothing. This also
  removes all typing into the TUI: the shared design typed a handshake and then the instruction with
  `tmux send-keys`, which needs input-box detection and clearing the restored blocked prompt.
- **One session per job, in one turn.** An update's read and publish run in the same turn; Claude Code accepts a
  publish after a read in the same conversation. `PostToolUse` returning `continue: false` ends the session as soon
  as the last planned result, or a stale read, arrives.
- **Pi decides every call.** `policy.ts` allows only the planned calls, in order and each once, with exact fields
  (plus the one-word `icon` Claude adds to a first publish), and `Read` only for the staged copy. A call waits for
  the previous call's result, so an update's publish cannot be allowed before its read shows `base_version`, even
  when Claude asks for both at once. Once a job has settled, every hook answer refuses and stops Claude Code. `Read` must be in
  `--tools` even though Claude rarely calls it: without it the CLI refuses publish, because publishing reads the
  file. Hooks use `onFailure: "block"`, so a hook that times out or fails blocks the call; this was observed
  with a held `PreToolUse`.
- **Results are structured.** Pi reads `tool_response`/`error` from hooks, never the screen; the screen is read only
  during startup to name the folder-trust and sign-in screens. The publish response has no content hash and the
  service wraps pages in its own shell, so Pi verifies that the reported path is the staged read-only copy and that
  the copy still matches the approved hash.
- **Conflicts come from the service.** Update compares the read's `artifactRead.ver` with `base_version` and stops
  on a mismatch. A competing publish between that read and the publish was refused by the service ("Publish refused
  — … a newer version …"), observed with a second session, so the check is not only preliminary. Only those refusal
  texts are conflicts and prove nothing was published; any other failure after an allowed publish, or no result at
  all, is "outcome unknown", and Pi never retries it.
- **Leave little behind, and delete only what the job owns.** Each job runs in its own folder under the trusted
  helper folder; subfolders inherit Claude Code's folder trust (observed). Claude Code names its per-folder state
  after the working directory (path characters other than letters and digits become `-`), so the folders named
  after the job folder belong to that job alone and are deleted whole. That covers the transcript and the empty
  scratchpad Claude Code starts under a second, unreported id. Paths not named after the job folder are deleted only
  when named by Pi's `--session-id`. Pi kills the session's process group if it outlives the tmux hangup, so nothing
  rewrites files after cleanup. Claude Code's prompt history keeps the one-line `PIJOB` prompt, which holds only a
  nonce.

## Consequences

The extension depends on undocumented CLI behavior: `Artifact` actions and result fields, refusal wording, the
scratchpad layout and the startup screens. `MIN_CLAUDE_VERSION` gates on 2.1.302, the verified version; there is no
upper bound, so a newer Claude Code can break jobs until the extension is updated. Tests drive a fake `claude` inside
real tmux, so they prove Pi's side of the protocol, not Claude Code's. The helper folder needs one manual trust; Pi
does not answer Claude Code's trust dialog for the user. Managed Claude Code settings still apply and can interfere.
Replace this extension once the Agent SDK exposes the `Artifact` tool.

## Verification

Spikes against Claude Code 2.1.302 on Linux established the facts above (tool availability in print mode, hook
payloads and responses, `dontAsk` behavior, same-turn read and publish, the competing-writer refusal, leftover
files). The real Pi TUI then ran list, publish, update, a stale update and read against a private test artifact,
reported the untrusted helper folder before it was trusted, and left no transcript, scratchpad or staged copy.
