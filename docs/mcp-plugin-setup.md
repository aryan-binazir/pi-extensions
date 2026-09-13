# Harbor MCP setup

Install this package with Pi and your existing GitHub SSH access:

```sh
pi install git:git@github.com:aryan-binazir/pi-extensions@main
pi config
```

Before enabling Harbor, disable or uninstall any other MCP client extension to
avoid overlapping tools and commands. If you followed the previous setup guide,
remove its separately installed adapter first:

```sh
pi remove npm:pi-mcp-adapter
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
refresh tools, and `/mcp-auth service` to sign in (saved in macOS Keychain on macOS). The example assumes
a server supporting dynamic public-client registration; otherwise configure
`oauth.clientId` using a registered public client supporting ephemeral loopback
callbacks. The authorization URL is shown, not automatically opened. Authenticate
again only when saved authorization cannot be refreshed. On macOS, install Xcode
Command Line Tools if needed (`xcode-select --install`) and allow the Harbor helper
Keychain access when macOS asks. Keychain failures are reported rather than falling
back to insecure storage. OAuth is session-only on other platforms.

For bearer-token servers, use `bearerTokenEnvVar` with an exported environment
variable instead of OAuth. Do not commit credentials. Read the service's current
MCP documentation for its supported endpoint, scopes, and administrator settings.
Installing the client does not grant account access.

The first connection asks to remember approval for that exact configuration and
config source; later startups/reloads reuse it. Tool and resource actions still
ask for consent by default. Headless startup may reuse remembered connection
approval, but actions still require explicit `consent: "allow"`. Use
`/mcp-forget service` to disconnect and remove that configuration's saved approval
and OAuth sign-in. This does not revoke tokens at the provider; other running
sessions observe the deleted sign-in before their next OAuth request. Exact raw-name
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
