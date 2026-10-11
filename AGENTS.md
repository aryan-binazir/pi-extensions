# Local agent setup

At the start of each session in this repository, read the [README agent setup checklist](README.md#agent-setup-checklist) and perform the [read-only machine setup verification](docs/agent-setup.md#verify-this-machines-setup). Recheck after setup changes. Report drift or unverified items; preserve optional choices and obtain Ar's approval before changing personal setup.

# MCP configuration

Use Pi's built-in MCP support. Keep personal servers and credentials in the user-scoped `~/.pi/agent/mcp.json`, preserve unrelated server entries when editing it, and ask Ar to run `/reload` afterward.

# Verification

- Before merging a PR, run `npm run check` locally, which runs typecheck, lint, and tests. Merge only when all checks pass on the final PR revision.
- Keep this repository free of CI workflows and GitHub Actions disabled. Verification runs locally to avoid consuming GitHub Actions minutes.
