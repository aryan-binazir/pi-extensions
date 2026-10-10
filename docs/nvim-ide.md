# Editor link

The installed `nvim-ide` extension connects Pi to the existing Claude Code IDE WebSocket server. Neovim uses claudecode.nvim in server-only mode; no extra Neovim plugin or personal configuration changes are required. Transport and discovery are documented in [ADR 012](adr/012-nvim-ide.md); request snapshots and navigation delivery are documented in [ADR 013](adr/013-editor-request-snapshots.md).

## Live viewing

Successful `edit` and `write` tools in this Pi session reveal the file in the editor's main window without moving focus, selecting text or changing the editor's mode. Relative tool paths use the active worktree. Failed tools, shell changes and delegated-agent edits do not trigger navigation.

- Follow shows the file, not the changed line; the cursor stays where Neovim last had it in that file. The protocol's `openFile` has no cursor-only position: claudecode.nvim turns a line or text position into a Visual selection, which the next `x`, `d`, `c` or `p` would act on and Pi would report as the user's selection. Follow also sends `makeFrontmost: false`; the default moves focus to that window, carrying Insert mode into the file or ending terminal mode for a Pi running in `:terminal`. When the focused window is the editor's main window, revealing still replaces its buffer. When Neovim has no ordinary editor window, for example when Pi's `:terminal` is the only window, claudecode.nvim splits one off and focuses it whatever `makeFrontmost` says; `/vim follow off` avoids that.
- Follow is on by default. `/vim follow off` disables it and clears queued destinations; `/vim follow on` re-enables it for subsequent edits.
- Rapid edits share a fixed 100 ms window; only the latest destination is revealed. There is one in-flight request and one replaceable pending destination.
- A stalled reveal expires after five seconds so newer edits can continue. A connected failure warns once until a later automatic or explicit reveal succeeds; it does not trigger an automatic retry loop.
- Edits during a disconnect are retained only if this session previously connected. Reconnection replays the latest destination if it is at most 30 seconds old. An acknowledged destination is not replayed, but a lost reply can cause the same location to be revealed again.
- Explicit `nvim_open` cancels pending automatic navigation before checking connectivity and remains immediate. Follow-off, session replacement and shutdown invalidate late callbacks and clear pending navigation. The follow preference lasts for the Pi process, surviving `/new`, `/resume`, `/fork` and `/reload`, and is on again after a restart; the pending navigation does not survive session replacement. They cannot undo a request the editor already received.

`/vim` reports the link, current file and follow setting. `/vim reconnect` forces discovery. `NVIM_IDE_TRACE=/path/to/file` logs transport state transitions for debugging. Without an editor, startup is quiet and idle discovery does not poll: it watches the lock directory, or its parent until the directory exists, and falls back to a 15-second poll only after a dropped connection or when neither can be watched.

## Request context and editor sends

Cursor and selection notifications are ambient in-memory state. `:ClaudeCodeSend`, file/tree mentions and similar editor sends queue in memory for submission. Nothing is written to Pi session history merely because the editor sends a notification.

On a submitted turn, Pi receives a deterministic `editor_context` section containing explicit sends followed by ambient editor context. Pi saves the section when constructing the request; saved snapshots and changes remain in local session history, forks and exports until those files are removed. Compaction does not erase raw history. The limit below bounds each snapshot, not all historical snapshots combined. Providers that render mid-conversation system updates can retain multiple changed snapshots in model context until compaction; the previous selection is not necessarily replaced.

- Total context: at most 100,000 JavaScript string characters (UTF-16 code units), including references, fences and notices.
- Selection receipt: at most 50,000 code units, without splitting a surrogate pair. A clipped selection is explicitly marked as incomplete.
- Range reads: regular files only, at most 2,000 lines, read serially in bounded chunks with the remaining shared body allowance. Scanning stops after 2,000,000 code units, including skipped source before the range. Missing, non-regular, unreadable, past-EOF and reversed ranges retain their reference with an explicit note. File/directory mentions without ranges remain references only. Rows split on `\n`, not bare carriage returns.
- References are reserved before bodies, explicit sends before ambient selection. References have a 20,000-character allowance and individual headers clip after 1,000 code units, plus a truncation marker. Omitted or clipped references and bodies are explicitly marked. Bodies use fences longer than any matching run in their content. Paths escape control characters and `<`; source escapes closing `editor_context` tags.
- The ready queue holds up to 50 sends, plus a separate pre-initialization buffer of up to 50 sends. Queue overflow and interrupted initialization are reported once per submitted batch to the UI when present and in the model's context, asking the user to re-send. Reference-budget omissions also produce a re-send notice.
- Relative sends resolve against the originating connection's live editor root at receipt. A burst shares a lookup with a one-second deadline. Pi's cwd and stale lock folders are never fallbacks. Failed or interrupted lookup is reported once on submission; unresolved paths are not given to the model to guess. A relative send received before initialization has no captured live root and is reported unresolved, rather than rebound to a potentially changed workspace after initialization. Absolute pre-initialization sends are preserved.
- Preparing a batch does not consume it. Assigning its request section acknowledges only that snapshot's original entries. New sends arriving during preparation stay queued when there is capacity. Prepared entries cannot be evicted while their request is assembled; if all 50 slots are prepared, new arrivals are rejected and reported rather than falsely reporting delivered entries as dropped. Absolute sends remain available after a disconnect. Replacing or reloading a session clears its in-memory state.

The content is reference data, not instructions. It remains subject to the model provider's separate data-retention policies. Acknowledgement records successful local request preparation, not provider acceptance or a successful response.

## Tools and verification

- `nvim_context`: workspace folders, open buffers and selection.
- `nvim_diagnostics`: language-server diagnostics for a file or all open buffers.
- `nvim_open`: immediately reveal a file, optionally selecting a one-based line range.

Selections use zero-based LSP positions; `openFile` uses one-based lines. Neovim sends zero-based inclusive mention rows, which the link normalizes after identifying the server. claudecode.nvim 2390c6e selects the line above each requested `openFile` line, and nothing for line 1, so `nvim_open` adds one for servers identifying as `claudecode-neovim` and reports the requested lines; a range past the last line is rejected by Neovim.

```sh
node --import tsx --test extensions/nvim-ide/index.test.ts extensions/nvim-ide/link.test.ts extensions/nvim-ide/session.test.ts
npm run check
```
