# Local agent setup

At the start of each session in this repository, read the [README agent setup checklist](README.md#agent-setup-checklist) and perform the [read-only machine setup verification](docs/agent-setup.md#verify-this-machines-setup). Recheck after setup changes. Report drift or unverified items; preserve optional choices and obtain Ar's approval before changing personal setup.

During setup, ensure the scoped models include `gpt-6.1-sol`, `gpt-6-luna`, and `claude-opus-5-5`; all three are mandatory. Follow [scoped model setup](docs/agent-setup.md#required-scoped-models), using this machine's existing model connections and preserving unrelated settings. Bash approvals must use `gpt-6-luna` with low reasoning. Follow [default thinking setup](docs/agent-setup.md#default-thinking) to configure the local startup effort.

Escape Continue is required. During setup, [install and enable it](docs/agent-setup.md#escape-continue), preserving other extension selections.

Repair Auto Permissions version drift using the required pin and upgrade procedure in [Automatic Bash permissions](docs/agent-setup.md#automatic-bash-permissions-external-package). Reporting a mismatch alone is not completion.

# MCP configuration

Use Pi's built-in MCP support. Keep personal servers and credentials in the user-scoped `~/.pi/agent/mcp.json`, preserve unrelated server entries when editing it, and ask Ar to run `/reload` afterward.

# Verification

- Before merging a PR, run `npm run check` locally, which runs typecheck, lint, and tests. Merge only when all checks pass on the final PR revision.
- Keep this repository free of CI workflows and GitHub Actions disabled. Verification runs locally to avoid consuming GitHub Actions minutes.
