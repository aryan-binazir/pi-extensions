# 012: Connect to the editor through the Claude Code IDE protocol

Status: accepted.

## Decision

Pi reuses the WebSocket MCP server that Claude Code's IDE extensions expose instead of a Pi-specific editor plugin. On this machine that server is [claudecode.nvim](https://github.com/coder/claudecode.nvim) running in server-only mode (`terminal.provider = "none"`); the same client works against the official VS Code and JetBrains extensions because the lock file, header and message shapes are identical. The server accepts several clients at once, so Claude Code and Pi can be connected to the same Neovim simultaneously.

The extension is on whenever it is installed. Session start scans `~/.claude/ide/*.lock` (or `$CLAUDE_CONFIG_DIR/ide`), keeps entries whose `pid` is alive, and picks the lock whose workspace folder contains the session directory, longest folder then newest file; `CLAUDE_CODE_SSE_PORT` overrides the choice when Pi is launched from the editor's own terminal. It connects to `ws://127.0.0.1:<port>` with the lock's token in `x-claude-code-ide-authorization`, sends MCP `initialize` and `notifications/initialized`. While disconnected it watches the lock directory and retries within 200 ms of a lock file appearing, with a fifteen-second poll as the fallback for a missing directory or a filesystem that does not report changes. The `ws` package is imported only once a matching lock exists, so sessions without an editor pay nothing beyond the shared typebox import. Nothing is reported to the user when no editor is present; the status bar shows the editor name while connected.

The link speaks JSON-RPC 2.0 directly over the `ws` package. Node's built-in WebSocket and the MCP SDK's WebSocket transport cannot send the required header, and the protocol surface is one request method plus two notifications, which does not justify the SDK's client. Requests carry a thirty-second deadline and honour the tool abort signal. Server-initiated requests other than `ping` are answered with method-not-found.

Editor context is ambient, matching Claude Code: the latest `selection_changed` notification is appended to each turn's system prompt as the active file with either the cursor line or the selected text, capped at 4,000 characters at receipt so a large visual selection is never held in memory. The status bar shows the active file and line or range, and is only repainted when that text changes. `at_mentioned` notifications (`:ClaudeCodeSend`, `:ClaudeCodeAdd`, tree sends) queue until the next turn; each is injected with up to 200 lines of the referenced range read from disk. The block states that the content is reference data, not instructions. Three tools are registered: `nvim_context` (workspace folders, open buffers, current selection), `nvim_diagnostics` (one file or all buffers) and `nvim_open` (open a file at a range).

Edits are shown, not gated. After a successful `edit` or `write` the editor opens the file at the first changed line via `openFile`. The IDE protocol's `openDiff` accept/reject flow is deliberately unused: Pi has no per-edit approval today and adding one through the editor would change how Pi is used, so that decision is left for a later ADR. `/vim follow off` disables the jump; `/vim` reports status and `/vim reconnect` forces rediscovery.

Line numbers differ across the protocol: `selection_changed` positions are zero-based LSP positions, `at_mentioned` and `openFile` lines are one-based. The prompt block converts selection lines to one-based.

## Verification

Tests run a fake IDE server with the real `ws` package: token verification, lock discovery and precedence, selection and mention tracking with malformed payloads, tool call success, error, timeout and abort, reconnection after the server drops the client, and prompt rendering. A live probe against a running claudecode.nvim 2390c6e returned workspace folders, open editors, the current selection and diagnostics through the same client.

## Sources

- claudecode.nvim `PROTOCOL.md`, `lua/claudecode/server/*.lua`, `lua/claudecode/lockfile.lua`, `lua/claudecode/tools/*.lua` at commit 2390c6e (2026-06-25).
- Installed Pi 0.85.1 `docs/extensions.md` and `docs/packages.md` (runtime dependencies are installed with `npm install` on package install).
- [Claude Code JetBrains](https://code.claude.com/docs/en/jetbrains) and [VS Code](https://code.claude.com/docs/en/vs-code) docs for the discovery and authentication flow.
