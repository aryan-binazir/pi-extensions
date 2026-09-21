# ADR 009: Active worktree routing inside the current Pi session

## Context

Working in a second checkout normally means a second Pi session, which loses the
conversation. Pi's own cwd, session storage and loaded resources cannot be moved
mid-session, so the extension has to route the tools that act on the filesystem —
bash, user shell commands and relative file-tool paths — at a different checkout
while the session itself stays put, and make that boundary visible.

## Decision

`/worktree` retains the current conversation and persists its active checkout in a versioned session entry. A shared process registry keyed by original cwd and session ID, cleared when switching sessions and at shutdown, exposes `getActiveCwd(originalCwd, sessionId)` to delegation and permission enforcement. Built-in relative file arguments become absolute before execution, and the bash spawn hook and user shell operations select the active directory without rewriting shell commands. Absolute paths retain their meaning. A version-attributed path helper mirrors Pi 0.85.1 tool normalization (leading `@`, tilde, file URLs and Unicode spaces) before resolving, and policy checks share this interpretation. Switching is restricted to idle turns.

Pi's session cwd, storage, loaded instructions/resources and arbitrary third-party extension internals do not move. The status line and per-turn instructions disclose that boundary and direct the agent to read the checkout's instructions. This is routing, not a filesystem sandbox.

Worktrees follow `~/repos/.worktrees/<primary-repo>/<name>`, default to `amb/<name>`, preserve an explicit branch and reuse checked-out branches. New branches use the remote origin default, then a local main or master; other repositories require an explicit --base. Quoted command arguments preserve spaces in checkout paths. Active Herdr sessions use the installed create/open/remove CLI. Git supplies equivalent checkout management outside Herdr, including macOS. Herdr removal uses the opaque `open_workspace_id` returned by its list API; null uses Git removal, and an unrecognized response blocks removal. A confirmed unavailable Herdr server falls back to Git. Current Herdr workspace removal is refused. Paths are canonicalized for macOS symlink aliases.

Removal requires interactive confirmation; dirty trees are skipped unless force was explicitly requested. Cleanup additionally requires a merged GitHub PR whose head matches the checkout HEAD, preventing cleanup of post-merge local commits. The primary checkout, original session directory and trees outside the managed layout cannot be removed. Cleanup records guard failures and missing checkout paths individually and continues, preserving all earlier results. Git worktree removal preserves branch refs. No tests operate on pre-existing host worktrees.

## Consequences

The extension owns the built-in bash execution override and inherits Pi's tool schema/rendering and process handling. Other extensions that override bash can conflict and must integrate with `getActiveCwd`. Headless commands cannot approve worktree mutation. Git-backed synthetic tests prove creation, reuse, branch preservation, removal protection, session restoration and real shell routing; Linux tests do not establish macOS desktop behavior.
