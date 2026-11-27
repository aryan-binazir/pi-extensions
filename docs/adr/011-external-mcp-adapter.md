# ADR 011: Retire Harbor in favor of an external MCP adapter

Status: retired. Pi now provides built-in MCP support; personal servers live in
user-scoped `~/.pi/agent/mcp.json` (see the
[setup checklist](../../README.md#agent-setup-checklist)).

This decision superseded [ADR 004](004-mcp-client.md) and
[ADR 007](007-harbor-mcp.md). It removed Harbor, its tests and its package entry
point, and documented the separately installed `pi-mcp-adapter@2.34.0` for
general MCP connectivity. Harbor's [third-party notices](../licenses/README.md)
remain as historical provenance. This records the removed setup, not current
guidance.
