# MCP plugin setup on a new machine

We recommend the community-maintained [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
instead of maintaining our bundled MCP client. It uses Pi's official package
system but is not a Pi-core or officially certified plugin. Third-party
extensions run with your user account's privileges; review and trust them before
installing.

## 1. Install both packages

With Pi installed and GitHub SSH access to this private repository:

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
pi install npm:pi-mcp-adapter
```

These are user-wide installs, available across projects. They do not modify Pi
core. The adapter is a separate package, not automatically installed by this
repository. For a development checkout, use `pi install /absolute/path/to/pi-extensions`
instead of the Git install; do not install both copies.

## 2. Disable the legacy MCP client

Run `pi config` and disable `extensions/mcp-client/index.ts` in this repository's
package. Keep the external adapter enabled. Both clients register overlapping
MCP tool/command names and should not run together.

Alternatively, merge the following package entries into `~/.pi/agent/settings.json`
(or the corresponding file under `PI_CODING_AGENT_DIR`). Preserve your other
settings and packages:

```json
{
  "packages": [
    {
      "source": "git:git@github.com:aryan-binazir/pi-extensions@main",
      "extensions": ["!extensions/mcp-client/index.ts"]
    },
    "npm:pi-mcp-adapter"
  ]
}
```

Use your existing source string in the object if you installed a different ref
or a local checkout. The exclusion leaves the package's other extensions enabled.
`pi list` should show this package as filtered and the adapter as a separate install.

## 3. Configure services

Restart Pi, then run:

```text
/mcp setup
```

The adapter supports project-shared `.mcp.json` and user-wide
`~/.config/mcp/mcp.json`. Its own overrides live in `~/.pi/agent/mcp.json`
and `.pi/mcp.json`. The setup UI can help import existing host configurations;
do not assume our legacy client's configuration schema transfers unchanged.

For each service (Linear, Notion, Slack, etc.), use the service's current MCP
setup documentation to obtain its supported server endpoint or launch command.
Available actions depend on the server, account scopes, and workspace/admin
permissions—not just the adapter. Slack availability in particular should be
checked against your workspace's supported integration.

For an OAuth server, authenticate from Pi with:

```text
/mcp-auth <configured-server-name>
```

OAuth credentials use the OS credential store. On headless Linux, this can
require an unlocked Secret Service/libsecret keyring. Authenticate separately on
each machine; never commit tokens, authorization codes, or credential-store data.
Share only reviewed, non-secret server configuration. Review detected MCP files
before use: local server definitions can execute commands on your machine.

Use `/mcp` to inspect server status and available tools. Connecting an account
and verifying its tools is a separate step from installing the plugin.

## Approvals and maintenance

The adapter provides explicit MCP tool approvals without an LLM classifier.
For example, set this in the adapter's MCP configuration to ask before every
MCP tool call:

```json
{
  "settings": {
    "approveTools": true
  }
}
```

Merge this with your existing configuration. Per-server overrides are supported;
see the [upstream configuration reference](https://github.com/nicobailon/pi-mcp-adapter#config).
This is an MCP approval setting, not an OS sandbox or a permission gate for
Pi's other tools.

Update the adapter independently:

```sh
pi update npm:pi-mcp-adapter
```

Restart Pi after updates. For reproducible installs, use a reviewed explicit
version, for example `pi install npm:pi-mcp-adapter@2.33.0`; pinned npm versions
are skipped by routine package updates. Version 2.33.0 declares Pi AI 0.85.x
compatibility; check release notes and compatibility again when upgrading Pi.
