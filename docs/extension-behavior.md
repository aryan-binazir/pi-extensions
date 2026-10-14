# Extension behavior

[Back to README](../README.md)

## Todos and sessions

Todos are versioned session entries restored from the active branch on resume
and tree navigation. Only one task may be `in_progress`. Send `todos: []` to
clear. A fully completed list hides its widget and reminders. Saved statuses
record declared progress; they do not prove completion.

`/effort new [LEVEL] [provider/model]` creates a session with a temporary model
and effort handoff. It does not overwrite saved defaults. Plain `/new` keeps
Pi's normal behavior.

Closing a BTW overlay aborts its request and discards the side conversation; its
answers never automatically enter the main conversation.

The prompt stash is memory-only and clears on session start, switch and reload.

Vi mode preserves pasted tabs, carriage returns and newlines while editing and
stashing. It strips unsafe terminal controls at insertion, and normal submission
additionally strips carriage returns. Large pastes use Pi-style collapsed
markers; motions, selections and edits treat each marker atomically, and undo,
registers, stash and editor replacement retain its payload. Counts apply to
motions, operators, doubled line operators, `x`, `p/P` and `nG/ngg`; counts on
insert entry, visual toggles, text objects and undo/redo are unsupported.
Registers are lowercase `a-z` and the unnamed register. Unsupported `f`, `F`,
`t`, `T`, `r`, `m` and `q` cancel pending commands and consume their argument.
Escape from insert mode also closes the completion popup. The exact supported vi
command set is documented in [ADR 001](adr/001-editor.md).

## Escape Continue

In the main editor, the normal interrupt action (Escape by default) cancels the
active run, waits for cancellation to settle, then starts one queued user
message in the same session. Steering messages take precedence over follow-ups.
Remaining queues retain their relative order, attachments and custom messages,
and then follow Pi's normal queue modes. Custom-only entries are not promoted as
user input; they stay queued for subsequent normal boundaries. The unsubmitted editor draft is untouched.
With no queued user message, normal Escape behavior applies.

Ctrl-X followed by Ctrl-S within 750 ms invokes the live interrupt handler
directly in the main editor without leaving Vi insert mode. Agent-run
interruptions preserve the cursor and draft.
It interrupts immediately even when autocomplete is open, leaving the popup
alone. Bash commands, retry backoff and compaction use Pi's current Escape
handling. With no active run, promotion, Bash command, retry or compaction, the
chord does nothing; it does not open the session tree or clear a Bash draft.
A second chord stops a pending promotion just as a second Escape does.

Standalone Ctrl-S still stashes the draft. Standalone Ctrl-X is forwarded to Pi
after the 750 ms wait, or immediately before another key. With default bindings,
this copies; rebinding Ctrl-X changes the forwarded action but keeps the wait.
Control bytes inside well-formed bracketed paste never form the chord. Pi treats
anything after the first paste-end marker as ordinary input.
Pending prefixes are discarded on
editor replacement, session shutdown and reload, and a delayed copy is skipped
if the main editor has lost focus. Selectors and dialogs keep their own keys.
Legacy, Kitty and modifyOtherKeys encodings are supported without keybinding
configuration.

A second Escape while cancellation or prompt preparation is pending stops the
promotion. A held-queue count is visible during cancellation, and stopping shows
an immediate notice. Queued messages and attachments stay waiting; they are
picked up by a later submitted prompt. Queues are memory-only, not durable
session entries. A manual submission during prompt preparation takes precedence
and cancels the promotion before either prompt commits. Accepted session replacement
or quit retires the promotion before asynchronous teardown; a cancelled replacement
leaves it eligible to continue. Accepted reload retires the promotion before its
first yield; a rejected TUI reload leaves it eligible to continue.

Autocomplete, dialogs, compaction and retry backoff keep their own Escape
handling. Vi mode keeps insert/visual-mode Escape; only a clean normal-mode
Escape reaches the interrupt handler. Programmatic `ctx.abort()` and stock dequeue
cancel a held promotion and restore its queued text using Pi's normal editor behavior;
this is text-only, unlike second-Escape retention of attachments and custom messages.
Direct `session.abort()` stops the promotion without dequeuing it. The extension is
inert in RPC, JSON and print modes.

Promotion uses Pi's normal prompt preflight, including `before_agent_start` and
image normalization, without repeating skill/template expansion. Third-party
`input` handlers still receive the already-processed prompt with
`source: "extension"`; a handler that transforms every source can transform it
again. If preflight rejects or handles the prompt without starting it, the
queue is kept waiting with a notice.

The [session seam](adr/020-escape-continue.md) keeps Pi flags, prompt ownership,
checkpoints and queue internals in `adapter.ts`; `promotion.ts` owns
cancellation and queue retention through its session interface. The adapter uses
guarded interactive-handler and prepared-queue internals, tested against Pi
0.99.1 and through the Pi 0.87.1, 1.0.2 and 1.2.0 TUIs. Table-driven version
fakes cover the 0.87 boolean preflight callback, the 0.99 baseline, a legacy
missing idle getter and 1.2 early streaming. Scoped run-start events support the
older boolean prompt-preflight callback. Foreign activity is checked after
abort; an owned prompt may be busy at its checkpoints. Cancellation is checked
at Pi's final asynchronous image-preparation boundary, before prompt options and
next-turn notifications are committed. The normal preflight observer is never
used to throw after commit. An unsupported layout warns once per session and
falls back to normal Escape behavior. No keybinding or personal setting is
changed by loading the extension.
