# Editor link

The installed `nvim-ide` extension connects Pi to the existing Claude Code IDE WebSocket server. Neovim uses claudecode.nvim in server-only mode; no extra Neovim plugin or personal configuration changes are required. Transport and discovery are documented in [ADR 012](adr/012-nvim-ide.md); request snapshots and navigation delivery are documented in [ADR 013](adr/013-editor-request-snapshots.md).

## Live viewing

Successful `edit` and `write` tools in this Pi session reveal the file at its first changed line when available. Relative tool paths use the active worktree. Failed tools, shell changes and delegated-agent edits do not trigger navigation.

- Follow is on by default. `/vim follow off` disables it and clears queued destinations; `/vim follow on` re-enables it for subsequent edits.
- Rapid edits share a fixed 100 ms window; only the latest destination is revealed. There is one in-flight request and one replaceable pending destination.
- A stalled reveal expires after five seconds so newer edits can continue. A connected failure warns once until a later reveal succeeds; it does not trigger an automatic retry loop.
- Edits during a disconnect are retained only if this session previously connected. Reconnection replays the latest destination if it is at most 30 seconds old. An acknowledged destination is not replayed, but a lost reply can cause the same location to be revealed again.
- Explicit `nvim_open` cancels pending automatic navigation and remains immediate. Follow-off, session replacement and shutdown invalidate late callbacks and clear pending navigation. They cannot undo a request the editor already received.

`/vim` reports the link, current file and follow setting. `/vim reconnect` forces discovery. `NVIM_IDE_TRACE=/path/to/file` logs transport state transitions for debugging. Without an editor, startup is quiet and idle discovery does not continuously poll a watchable lock directory.

## Request context and editor sends

Cursor and selection notifications are ambient in-memory state. `:ClaudeCodeSend`, file/tree mentions and similar editor sends queue in memory for submission. Nothing is written to Pi session history merely because the editor sends a notification.

On a submitted turn, Pi receives a deterministic `editor_context` section containing explicit sends followed by ambient editor context. Pi saves the section when constructing the request; saved snapshots and changes remain in local session history, forks and exports until those files are removed. Compaction does not erase raw history. The limit below bounds each snapshot, not all historical snapshots combined.

- Total context: at most 100,000 JavaScript string characters (UTF-16 code units), including references, fences and notices.
- Selection receipt: at most 50,000 code units, without splitting a surrogate pair. A clipped selection is explicitly marked as incomplete.
- Range reads: at most 2,000 lines, read serially with the remaining shared body allowance. Unreadable files retain their reference without a body; file/directory mentions without ranges remain references only.
- References are reserved before bodies, explicit sends before ambient selection. References have a 20,000-character allowance and individual headers are capped at 1,000 characters. Omitted or clipped references and bodies are explicitly marked. Bodies use fences longer than any matching run in their content.
- Queues hold up to 50 sends, including a separately bounded pre-initialization buffer. Queue overflow and interrupted initialization are reported once per submitted batch, asking the user to re-send.
- Relative sends resolve against the originating connection's live editor root at receipt. A burst shares a lookup with a one-second deadline. Pi's cwd and stale lock folders are never fallbacks. Failed or interrupted lookup is reported once on submission; unresolved paths are not given to the model to guess.
- Preparing a batch does not consume it. Assigning its request section acknowledges only that snapshot's original entries. New sends arriving during preparation stay queued. Absolute sends remain available after a disconnect. Replacing or reloading a session clears its in-memory state.

The content is reference data, not instructions. It remains subject to the model provider's separate data-retention policies. Acknowledgement records successful local request preparation, not provider acceptance or a successful response.

## Tools and verification

- `nvim_context`: workspace folders, open buffers and selection.
- `nvim_diagnostics`: language-server diagnostics for a file or all open buffers.
- `nvim_open`: immediately reveal a file, optionally selecting a one-based line range.

Selections use zero-based LSP positions; `openFile` uses one-based lines. Neovim sends zero-based inclusive mention rows, which the link normalizes after identifying the server.

Database-free verification uses the actual WebSocket transport against isolated synthetic IDE servers:

```sh
node --import tsx --test extensions/nvim-ide/index.test.ts extensions/nvim-ide/link.test.ts
npm run check
```
