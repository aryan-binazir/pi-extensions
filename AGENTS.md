# MCP configuration

Use Pi's built-in MCP support. Keep personal servers and credentials in the user-scoped `~/.pi/agent/mcp.json`, preserve unrelated server entries when editing it, and ask Ar to run `/reload` afterward.

# Verification

- Before merging a PR, run `npm run check` locally, which runs typecheck, lint, and tests. Merge only when all checks pass on the final PR revision.
- Keep this repository free of CI workflows and GitHub Actions disabled. Verification runs locally to avoid consuming GitHub Actions minutes.
