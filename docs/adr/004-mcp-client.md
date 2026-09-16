# 004: Keep MCP protocol and Pi policy separate

Status: retired; superseded by [ADR 011](011-external-mcp-adapter.md).

Historical decision for the removed bundled client, not current setup guidance.

Pi has no built-in MCP client. The extension must support stdio, Streamable HTTP and legacy SSE without owning a second JSON-RPC implementation.

Use the maintained official `@modelcontextprotocol/sdk` client for transport framing, request IDs, capability negotiation, cancellation, progress and OAuth. `McpConnection` owns connection lifetime and bounded configuration; the Pi entry point owns discovery, consent, tool registration and session cleanup. `SessionOAuth` supplies the SDK's session credential interface and a state-checked loopback callback. No tokens persist beyond the session.

Merge complete server entries in global, trusted-project, explicit order. Preserve original tool schemas. Namespace tools by both exact server and tool names. Remote tool annotations remain untrusted metadata; server consent is enforced by the MCP extension. A project-derived server is unusable after project trust is revoked. Session changes invalidate previously registered callbacks.

Resources and prompts return bounded untrusted data through one bridge tool. Neither sampling nor nested agents are enabled. Legacy SSE is explicit, which avoids retrying a failed authentication or mutation against another transport. Configuration or OAuth grants do not imply a remote operation was undone when its request is cancelled.

This trades persistent login convenience and automatic transport detection for smaller credential and retry boundaries. Live provider OAuth compatibility and remote server correctness remain environmental limits. Tests use real SDK transports with local fixture servers.

Sources: [SDK client guide](https://ts.sdk.modelcontextprotocol.io/client), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), installed Pi 0.85.1 `docs/extensions.md` dynamic registration, project trust and lifecycle sections.
