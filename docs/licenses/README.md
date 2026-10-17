# Third-party notices

## OpenAI Codex: Guardian

The [Guardian extension](../guardian.md) ports Codex's approval stack: exec
policy rules, shell command parsing, the macOS Seatbelt sandbox, permission instructions, and the
Guardian auto-reviewer. Our inspiration from this code comes from there:
[openai/codex](https://github.com/openai/codex) at revision
[`ce0323f2f2d3b25e82806cd555237da3db4e1897`](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897),
Copyright 2025 OpenAI, licensed under the [Apache License 2.0](openai-codex-APACHE-2.0.txt) with this
[NOTICE](openai-codex-NOTICE.txt). The license and NOTICE at that revision match the copies here.

The TypeScript is a translation, and each ported file names its Codex source in a header.
The Seatbelt `.sbpl` policies under `extensions/guardian/seatbelt/` and the prompt templates under
`extensions/guardian/prompts/` are verbatim copies. The tests are ported from Codex's own tests.
[ADR 025](../adr/025-guardian.md) records where Guardian departs from Codex.

`extensions/guardian/shlex.ts` translates the [shlex](https://crates.io/crates/shlex) crate 1.3.0, the
version Codex uses. Copyright 2015 Nicholas Allegra (comex), dual-licensed MIT or Apache-2.0; it is
used here under Apache-2.0.

## OpenAI Codex: Harbor MCP

OpenAI Codex — Copyright 2025 OpenAI. Reference revision:
[`944d6fd1ba4baab69dbedd205282dc72ec20abb5`](https://github.com/openai/codex/tree/944d6fd1ba4baab69dbedd205282dc72ec20abb5).

Reference files: `codex-rs/config/src/mcp_types.rs`,
`codex-rs/codex-mcp/src/{connection_manager,pagination,tools}.rs`, and
`codex-rs/rmcp-client/src/rmcp_client.rs`.

These references informed the now-retired Harbor MCP implementation (see
[ADR 011](../adr/011-external-mcp-adapter.md)). Its configuration, catalog and
lifecycle implementations were independently written TypeScript. The [Apache-2.0 license](openai-codex-APACHE-2.0.txt) and
[original NOTICE](openai-codex-NOTICE.txt) are included for attribution. No upstream
UI code is included; the original NOTICE is retained in full for provenance.

Runtime npm dependencies retain their licenses in their own distributions.
