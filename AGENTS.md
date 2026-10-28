# Setup

At each interactive top-level repository session, read the [setup checklist](README.md#agent-setup-checklist) and run the [read-only machine audit](docs/agent-setup.md#verify-this-machines-setup). Delegated children, implementers, reviewers and workflow stages skip this audit. Recheck after setup changes; report drift and unverified items. Preserve optional choices and obtain Ar's approval before changing personal setup.

For approved setup changes, follow the [setup guide](docs/agent-setup.md), including required extensions, default thinking, and Guardian's reviewer, shared-policy location and use of the footer's stable checkout. Required scoped models are `gpt-6.1-sol`, `gpt-6-luna`, and `claude-opus-5-5`; preserve existing model connections and unrelated settings.

Use Pi's built-in MCP with personal servers and credentials in user-scoped `~/.pi/agent/mcp.json`. Preserve unrelated entries; ask Ar to `/reload` after edits.

# Verification

Before merging, `npm run check` must pass locally on the final PR revision. Keep CI workflows absent and GitHub Actions disabled.

# Maintaining instructions

Prune before adding. Prefer existing docs with conditional pointers; avoid duplicating global rules, code, lint or tests. Keep this file under 1,000 `o200k_base` tokens.
