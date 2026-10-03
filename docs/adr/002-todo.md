# ADR 002: Branch-local declared todos

Accepted for the interactive-tools package.

## Context

A task list has to survive resume, fork, reload and tree navigation without
becoming a project file or a replay of full-session history, and it must never
claim progress the tool caller did not declare.

## Decision

Todos use the public session branch API and versioned custom entries, not a
project file or full-session history. `todo_write` replaces a normalized list and
permits at most one in-progress task. Restoration follows the selected branch on
startup, resume, fork, reload and tree navigation.

Delivered user messages advance the stale-turn count, including queued steering
and follow-up messages. Each accounting snapshot follows its user message on
the selected branch. Pending counts are saved at the next user delivery or when
provider context is composed, with an end-of-run fallback.
Reminders strengthen at three and six unchanged messages, and repeating an
identical declaration does not reset the count. Each provider request gets a
current reminder in request-only context. Reminders do not enter saved history
or the system prompt, and completion or clearing removes them on the next request.

Completion is only a tool caller's declaration, never inferred from assistant
prose or tool activity. All-completed lists remain in history but clear the widget
and reminders; `[]` clears the list. Invalid or future-version snapshots clear
state rather than resurrecting obsolete progress.

## Consequences

Schemas use Pi's `StringEnum` for provider compatibility. Tests exercise
registered tools and lifecycle hooks. The disposable sandbox harness additionally
uses Pi's real SessionManager to prove disk resume, branch navigation and
project-changing forks without provider calls.
