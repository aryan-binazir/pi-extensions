# MCP / Linear setup (external adapter)

Harbor MCP is retired. Install the free external adapter separately; this
repository no longer ships a general MCP client:

```sh
pi install npm:pi-mcp-adapter@2.34.0
```

Remove any explicit loading of the retired Harbor entrypoint and avoid loading
multiple MCP clients. This is a Pi package install, not a repository dependency.
Review upgrades before changing the pin.

## Configuration

Merge this example into `~/.pi/agent/mcp.json` (or
`$PI_CODING_AGENT_DIR/mcp.json`), the Pi-specific global override. Preserve unrelated
settings and servers. Do not copy the old Harbor `servers`/`consent` format.

```json
{
  "settings": {
    "hostConfigDiscovery": "off",
    "mcpFooterStatus": "off",
    "approveTools": true,
    "scriptMode": false
  },
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "auth": "oauth",
      "lifecycle": "lazy",
      "approveTools": false
    }
  }
}
```

The per-server `approveTools` setting **overrides** the global setting. The
Linear-only `false` setting implements the standing preference in [AGENTS.md](../AGENTS.md).
Other servers still require approval for every tool call unless explicitly
overridden. Preserve unrelated settings and servers when applying this example.
Back up the user config before editing, validate the resulting JSON, and run
`/reload` afterward. Configure the external adapter rather than modifying its
installed package files.

Supported approval settings are `true` (prompt for every tool), `false` (no
adapter approval prompts), or an array of tool-name patterns (prompt only for
matching tools; unmatched tools run without prompting). Pattern matching is not
semantic read/write classification. Disabling `scriptMode` hides `mcpScript`;
it is not a sandbox.

`hostConfigDiscovery: "off"` disables automatic host-specific discovery, not
standard shared files or explicit imports. The adapter also reads shared global
MCP files (notably `~/.config/mcp/mcp.json`) and project `.mcp.json` / `.pi/mcp.json`;
project overrides take precedence over this global policy. Audit those files and
any explicit imports before trusting the effective configuration. `/mcp setup`
can inspect configuration paths; do not adopt unrelated host configurations.

`mcpFooterStatus: "off"` hides the persistent MCP footer without changing
connections or tool availability. Use `/mcp status` on demand, or set `"compact"`
for a shorter footer. Separate subagent tracker status is unaffected. Run
`/reload` after changing this setting.

## Authenticate and use

Run `/reload` or restart Pi, then:

```text
/mcp-auth linear
```

Complete the browser OAuth flow with your Linear account. If Pi is remote and
the browser cannot reach its localhost callback, follow the adapter's manual
callback instructions. Authentication grants account access; the approval policy above separately
allows Linear mutations without adapter prompts. Persistent OAuth uses the OS credential store by default and fails
closed if it is unavailable. No credentials, authorization codes, callback URLs,
or token files belong in this repository. The old Harbor credentials/config are
not automatically migrated; authenticate through the adapter.

Use `/mcp` for status and `/mcp reconnect linear` to refresh discovery. Lazy
lifecycle connects on demand rather than at startup. The single `mcp` proxy is
the default; discover and inspect a tool before calling it:

```js
mcp({ connect: "linear" })
mcp({ server: "linear" })
mcp({ search: "linear issues" })
mcp({ describe: "linear_get_issue" })
mcp({ tool: "linear_get_issue", args: { id: "TEAM-123" } })
```

Use the actual names and argument schema returned by discovery, not assumptions
from these examples. When approval is enabled for a tool, the popup offers **Allow once**, **Allow for
session**, or **Deny**; there is no persistent **Always allow** option. Session
grants are scoped to the server, tool definition, and exact arguments: changing
arguments prompts again. Grants can persist on the active session branch and
restore on resume. With the Linear setting above, this popup is bypassed.
Headless calls needing approval fail closed with `approval_required`. Permission
broker extensions can affect decisions; this guide assumes no broker overrides.
Bash-only Auto Permissions does not itself protect MCP calls.

Native Pi tools are optional: add `"directTools": true` to Linear to register
all its tools, or an array of selected original names for a smaller tool list.
The same approval policy applies to direct and proxy calls. The proxy avoids
loading every schema into model context. Reload after configuration changes.

The adapter is free to install; Linear access, provider usage and other services
may have their own costs. Installation does not grant service access. No live
OAuth or remote mutation is exercised by this repository's tests. See the
[upstream package documentation](https://www.npmjs.com/package/pi-mcp-adapter)
for transport, credential-store and platform limitations.
