# Extension behavior

[Back to README](../README.md)

## Todos and sessions

Todos are versioned session entries restored from the active branch on resume
and tree navigation. Only one task may be `in_progress`. Send `todos: []` to
clear. A fully completed list hides its widget and reminders. Saved statuses
record declared progress; they do not prove completion.

Todo appends request-only reminders through Pi's public `context_with_system`
event, available in the pinned 0.99.1 SDK, preserving system updates in their
original transcript positions. Stale reminders strengthen at three and six
delivered user messages. Accounting stops at six until the list changes; resume
keeps the same reminder strength, including older snapshots with higher counts.
Identical declarations only write a snapshot when stale accounting is pending.

`/effort new [LEVEL] [provider/model]` creates a session with a temporary model
and effort handoff. It does not overwrite saved defaults. Plain `/new` keeps
Pi's normal behavior.

Closing a BTW overlay aborts its request and discards the side conversation; its
answers never automatically enter the main conversation. BTW and the subagent
tracker share a [bounded tool-free provider call](adr/022-side-completion.md);
their prompts, display and scheduling remain caller-owned.

The prompt stash is memory-only and clears on session start, switch and reload.
Vi, prompt stash and Escape Continue share one [main-editor input pipeline](adr/021-editor-input.md).
It frames each raw input once. Ctrl+Enter invokes Escape Continue; Ctrl+S stashes the draft. Paste payloads
never reach key bindings. Editor replacement transfers the visible draft and paste registry,
reattaches bindings and releases the outgoing Vi cursor before creating its
replacement. Pi can independently reapply its stock cursor setting after reload;
Vi still repairs that setting when the focused editor renders.

Vi mode preserves pasted tabs, carriage returns and newlines while editing and
stashing. It strips unsafe terminal controls at insertion, and normal submission
additionally strips carriage returns. Large pastes use Pi-style collapsed
markers; motions, selections and edits treat each marker atomically, and undo,
registers, stash and editor replacement retain its payload. Counts apply to
motions, operators, doubled line operators, `x/X`, `r/s/S/D/C/Y/J/~`, `p/P` and `nG/ngg`; counts on
insert entry, visual toggles, text objects and undo/redo are unsupported.
Registers are lowercase `a-z` and the unnamed register. Character finds
`f/F/t/T` stay on the current line; `;` repeats and `,` reverses the find.
`W/B/E/ge/gE`, bracket matching with `%`, `ib/ab/iB/aB`, replacement with `r`,
joins with `J`, and `gu/gU/g~` case operators are supported. `Y` yanks to the
end of the line. Visual `o/O` swaps selection ends and `u/U/~` changes case.
Unsupported `m/q`, and `r` outside normal mode or with a pending operator,
cancel pending commands and consume their argument.

`/` and `?` capture up to 256 UTF-16 code units in the mode label without
searching. Enter ends capture without submitting; Escape cancels. Backspace
removes a grapheme, or cancels an empty query. Native editor actions are
absorbed, app actions and extension shortcuts keep their normal priority, and
bracketed paste appends control-stripped text to the query. The draft and
selection stay unchanged unless a forwarded handler changes them. Capture also
starts after pending `g` or text-object prefixes. Enter while awaiting a find
or replace argument cancels that command without submitting. Real search and
repeat-dot remain unsupported.
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

Ctrl+Enter invokes the live interrupt handler
directly in the main editor without leaving Vi insert mode. Agent-run
interruptions preserve the cursor and draft.
It interrupts immediately even when autocomplete is open, leaving the popup
alone. Bash commands, retry backoff and compaction use Pi's current Escape
handling. With no active run, promotion, Bash command, retry or compaction, the
shortcut does nothing; it does not open the session tree or clear a Bash draft.
A second Ctrl+Enter stops a pending promotion just as a second Escape does.

Ctrl+S still stashes the draft. Ctrl+X reaches Pi immediately, so the former
Ctrl+X, Ctrl+S chord now copies and then stashes with default bindings.
The terminal must distinguish Ctrl+Enter from Enter through Kitty keyboard
protocol or xterm modifyOtherKeys. Plain Enter retains its normal behavior.
Key sequences inside bracketed paste never invoke the shortcut. Pi treats
anything after the first paste-end marker as ordinary input. Selectors and
dialogs keep their own keys.

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
