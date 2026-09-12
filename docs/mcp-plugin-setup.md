# Harbor MCP setup

Install this package with Pi and your existing GitHub SSH access:

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
pi config
```

Enable `extensions/mcp-client/index.ts`, then restart Pi or run `/reload`. For a
development checkout use `pi install /absolute/path/to/pi-extensions` instead;
do not install both copies. If you previously excluded this extension in package
settings, remove that exclusion through `pi config`. No separate MCP plugin,
additional runtime or helper executable is required.

Create `~/.pi/agent/mcp.json` for user-wide configuration, or `.pi/mcp.json` in a
trusted project. An explicit `--mcp-config /path/to/config.json` overrides complete
same-name server entries. Example (replace with your service's documented URL):

```json
{
  "servers": {
    "service": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {},
      "consent": "ask"
    }
  }
}
```

Reload config, then use `/mcp` for status, `/mcp-connect service` to connect or
refresh tools, and `/mcp-auth service` for session-only OAuth. The example assumes
a server supporting dynamic public-client registration; otherwise configure
`oauth.clientId` using a registered public client supporting ephemeral loopback
callbacks. The authorization URL is shown, not automatically opened. Authenticate
again after reload. Tokens are not persisted.

For bearer-token servers, use `bearerTokenEnvVar` with an exported environment
variable instead of OAuth. Do not commit credentials. Read the service's current
MCP documentation for its supported endpoint, scopes, and administrator settings.
Installing the client does not grant account access.

Connections and actions ask for consent by default; headless operation requires
explicit `consent: "allow"` for that configured server. Exact raw-name
`allowTools`/`denyTools` lists narrow tools, with deny taking precedence. Remote
read-only annotations never grant permission. Stdio servers execute with your
user's permissions, not inside an automatic sandbox.

Harbor accepts alternative JSON field names (`mcp_servers`,
`startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools`,
`env_vars`, `http_headers`, `env_http_headers`, `bearer_token_env_var`). This is
a JSON-only configuration format. Unknown fields and conflicting aliases fail
closed; third-party adapter configurations need explicit conversion.

See the [client reference](../extensions/mcp-client/README.md) for the complete
configuration, transport, deadline, output, OAuth and compatibility boundaries.
Update this package through Pi's normal package updates, then reload.
