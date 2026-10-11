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
Remaining queues retain their order, attachments and custom messages, and then
follow Pi's normal queue modes. The unsubmitted editor draft is untouched.
With no queued user message, normal Escape behavior applies.

A second Escape while cancellation or prompt preparation is pending stops the
handoff. Queued messages and attachments stay waiting, with a notice; they are
picked up by a later submitted prompt. Queues are memory-only, not durable
session entries. Reload or session shutdown cancels a pending handoff; it never
starts in the replacement session.

Autocomplete, dialogs, compaction and retry backoff keep their own Escape
handling. Vi mode keeps insert/visual-mode Escape; only a clean normal-mode
Escape reaches the interrupt handler. Programmatic `ctx.abort()` is unchanged.
The extension is inert in RPC, JSON and print modes.

Promotion uses Pi's normal prompt preflight, including `before_agent_start` and
image normalization, without repeating skill/template expansion. Third-party
`input` handlers still receive the already-processed prompt with
`source: "extension"`; a handler that transforms every source can transform it
again. If preflight rejects or handles the prompt without starting it, the
queue is kept waiting with a notice.

The compatibility adapter uses guarded interactive-handler and prepared-queue
internals, tested against Pi 0.99.1. An unsupported layout warns once per session
and falls back to normal Escape behavior. No keybinding or personal setting is
changed by loading the extension.

## Worktrees

`/worktree feature` creates or reuses `amb/feature` at
`~/repos/.worktrees/<repo>/feature`. Use `--branch exact/name` to preserve an
explicit branch and `--base ref` to choose a starting ref. `/worktree list`
shows checkouts; `/worktree original` restores the original directory.
Active Herdr sessions use Herdr's worktree APIs; other environments use Git.

If an existing checkout's directory is missing or is no longer a directory,
opening it fails with its path instead of switching the session there. Restoring
the directory makes it reusable again. To recover a deleted Git-managed checkout:

1. Run `/worktree original` if the session still targets the missing path.
2. Move aside any file that has replaced the directory.
3. Run `git worktree remove --force /absolute/path` from the original repository.
4. Retry the `/worktree` command.

For Herdr-managed checkouts, restore the directory or resolve the missing
checkout in Herdr before retrying. The extension does not automatically discard
Git or Herdr state.

The conversation stays in the same session. Built-in bash, user shell commands
and relative file-tool paths use the active checkout. Absolute paths keep their
meaning. Pi's session storage, loaded instructions/resources and arbitrary
extension internals retain the original session directory. The footer and
per-turn instructions state this boundary. Read the new checkout's instructions
before editing.

`/worktree remove /absolute/path` requires confirmation and skips dirty trees.
Supply exactly one nonempty path argument; quote paths containing spaces.
`--force` explicitly allows dirty removal. `/worktree cleanup` additionally
requires a merged GitHub PR whose head still matches the checkout. These
commands preserve branch refs.

Delegated children are launched with a validated workspace and builtin tool list.
Only launch-time checks apply. These do not sandbox child tools or trusted
extension JavaScript. External approval plugins are not automatically inherited.
