# Local agent setup

Pi subagent children, workflow stages, and delegated implementer/reviewer runs: skip this section and continue with your assigned task. At the start of each of Ar's interactive top-level sessions in this repository, read the [README agent setup checklist](README.md#agent-setup-checklist) and perform the [read-only machine setup verification](docs/agent-setup.md#verify-this-machines-setup). Recheck after setup changes. Report drift or unverified items; preserve optional choices and obtain Ar's approval before changing personal setup.

During setup, ensure the scoped models include `gpt-6.1-sol`, `gpt-6-luna`, and `claude-opus-5-5`; all three are mandatory. Follow [scoped model setup](docs/agent-setup.md#required-scoped-models), using this machine's existing model connections and preserving unrelated settings. Guardian's reviewer must be `openai-codex/gpt-6-luna~fast` at low reasoning, which is its default. Follow [default thinking setup](docs/agent-setup.md#default-thinking) to configure the local startup effort.

Escape Continue is required. During setup, [install and enable it](docs/agent-setup.md#escape-continue), preserving other extension selections.

Regen is required. During setup, [install and enable it](docs/agent-setup.md#regen), preserving other extension selections.

Guardian is the required approval engine. During setup, [enable it](docs/agent-setup.md#guardian) from the same stable checkout as the footer. Its shared reviewer policy and rules load from that checkout's `personal-settings/guardian/`; keep shared policy there, not in a machine-local fork.

# MCP configuration

Use Pi's built-in MCP support. Keep personal servers and credentials in the user-scoped `~/.pi/agent/mcp.json`, preserve unrelated server entries when editing it, and ask Ar to run `/reload` afterward.

# Verification

- Before merging a PR, run `npm run check` locally, which runs typecheck, lint, and tests. Merge only when all checks pass on the final PR revision.
- Keep this repository free of CI workflows and GitHub Actions disabled. Verification runs locally to avoid consuming GitHub Actions minutes.
