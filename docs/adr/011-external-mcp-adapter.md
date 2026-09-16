# ADR 011: Retire Harbor in favor of an external MCP adapter

Status: accepted. Supersedes [ADR 004](004-mcp-client.md) and
[ADR 007](007-harbor-mcp.md).

Remove the bundled Harbor implementation, tests and package entrypoint. General
MCP connectivity now uses the separately installed free `pi-mcp-adapter@2.34.0`;
[setup and policy](../mcp-plugin-setup.md) are documented rather than implemented
here. No user settings, installed package clones or credentials are changed by
this repository migration.

Use lazy Linear OAuth and proxy tools by default, with optional direct tools.
Global approval remains required. A Linear-only original-name pattern override
allows reads automatically while gating current mutation verbs. This is not a
semantic read/write classifier: catalog changes require review. Disable host
config discovery and MCP scripting in the documented configuration; shared and
project config precedence still needs operator review.

Keep the MCP SDK for the computer-use macOS client and its fixture server. Keep
Zod to satisfy the SDK's required peer dependency. Retain the Codex attribution
and license files as historical provenance. Historical Harbor guarantees and
removed tests do not describe or verify the external adapter.
