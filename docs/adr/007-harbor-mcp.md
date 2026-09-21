# ADR 007: Harbor MCP

Status: retired; superseded by [ADR 011](011-external-mcp-adapter.md), which
replaced the bundled client with the external `pi-mcp-adapter`.

Harbor was Pi's bundled TypeScript MCP client, built on the official MCP SDK so
that only Pi-specific configuration, consent and lifecycle behavior lived in the
extension. Two decisions are worth keeping: OAuth credentials persisted in the
macOS Keychain through a bundled native Security-framework helper (other
platforms kept session-only OAuth, and compiler or Keychain failures failed
closed rather than falling back to plaintext), and cross-process identity leases
serialized OAuth operations, reloaded state before requests and coordinated
`/mcp-forget` with refresh so stale sessions could not overwrite rotated tokens
or recreate a forgotten identity.

Third-party attribution and licenses remain in [`../licenses`](../licenses). This
records the removed implementation, not the current adapter's guarantees.
