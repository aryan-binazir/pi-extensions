# 029: Reviewed host execution by default

Status: accepted.

## Context

The default OS sandbox blocked Git metadata writes and local TCP connections. Network restrictions
also made `gh` report authentication failures despite a working host login. Retrying routine work
with escalation added failed calls and misleading instructions.

## Decision

Guardian defaults to `sandbox.mode: "host"`. It reuses the existing unsandboxed approval path:
command rules decide first, unmatched commands and all file changes require approval, and approved
actions run with Pi's normal environment and credentials. Automatic review remains on by default.
Railway/database boundaries and connector gates still apply. `never` permits only commands covered
by explicit allow rules and rejects file changes.

The reviewer retains its read-only inspection sandbox. Main-agent instructions and reviewer context
describe the actual execution mode. Host mode needs no sandbox escalation parameters.

Explicit sandbox modes retain their behavior. For compatibility, a saved `sandbox` object without
`mode` still selects `workspace-write`; an absent object selects `host`. `danger-full-access` keeps
its existing unrestricted behavior. Personal settings are not rewritten.

## Consequences

Approved host actions have the user's ordinary filesystem and network access. The reviewer and
command rules are the approval boundary; approved programs are not OS-confined. Every reviewed
command and file change adds latency. File contents go to the reviewer and the local action audit,
and automatic review retains its 256 KiB action limit.

Tests exercise the real Pi session and tool interfaces for approval, denial, cancellation, config
changes, legacy sandbox behavior, and prompt accuracy. Runtime verification uses isolated Git and
TCP fixtures plus an authorized read-only `gh` request through Guardian.
