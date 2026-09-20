# MCP permissions

- When configuring or repairing MCP access, follow [the external adapter setup guide](docs/mcp-plugin-setup.md). Ar's standing preference is `mcpServers.linear.approveTools: false` in the user-scoped MCP config, allowing all Linear calls, including mutations and deletions, without adapter prompts. Preserve other servers' approval settings; configure the external plugin rather than patching its installed code. Back up the config before editing and ask Ar to run `/reload` afterward.

# Verification

- Before merging a PR, run `npm run check` locally, which runs typecheck, lint, and tests. Merge only when all checks pass on the final PR revision.
- Keep this repository free of CI workflows and GitHub Actions disabled. Verification runs locally to avoid consuming GitHub Actions minutes.
