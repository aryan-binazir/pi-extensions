# Harbor MCP

Harbor MCP is a bundled TypeScript client for Pi, built on the official
TypeScript MCP SDK. Enable `extensions/mcp-client/index.ts` with `pi config`,
then `/reload`. No separate adapter or additional runtime is needed.
See [architecture](../../docs/adr/007-harbor-mcp.md) and
[setup](../../docs/mcp-plugin-setup.md).

## Configuration

JSON configuration merges complete server entries in this order:

1. `mcp.json` in Pi's agent directory, normally `~/.pi/agent/mcp.json`.
2. `.pi/mcp.json` in the trusted project (Pi's configured project-directory name).
3. The explicit `--mcp-config /path/to/mcp.json` file.

Higher priority replaces the whole same-name entry, not individual fields.
Unrelated servers remain. Untrusted project config is never read; project trust
and the project cwd are checked again before actions. Explicit config is a
user-selected trust boundary. The merged map is limited to 32 servers.

```json
{
  "servers": {
    "local": {
      "command": "/absolute/path/to/mcp-server",
      "args": ["--stdio"],
      "cwd": "/path/to/workspace",
      "envVars": ["SERVICE_TOKEN"],
      "env": {"MODE": "read-only"},
      "allowTools": ["lookup"],
      "denyTools": ["delete"],
      "consent": "ask",
      "startupTimeoutMs": 10000,
      "toolTimeoutMs": 60000,
      "maxOutputBytes": 65536
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "SERVICE_TOKEN",
      "envHeaders": {"X-Workspace": "WORKSPACE_ID"}
    },
    "oauth": {
      "url": "https://oauth.example.com/mcp",
      "oauth": {"clientId": "pre-registered-public-client", "scope": "read"}
    },
    "off": {"command": "/path/to/another-server", "enabled": false}
  }
}
```

Each entry requires exactly one command or URL. `http` (default for URLs) means
Streamable HTTP; legacy SSE requires `transport: "sse"`. Authentication errors
never trigger transport fallback. URLs require HTTPS except loopback HTTP;
credentials in URLs, fragments and redirects are rejected.

Stdio supports `args`, `cwd`, `envVars` and `env`. Relative cwd resolves against
the session project directory, not the config file. The child receives the SDK's
minimal inherited environment, then named `envVars`, then explicit `env` overrides.
HTTP supports `headers`, `envHeaders`, `bearerTokenEnvVar` and `oauth`. Environment
headers override static headers case-insensitively; bearer auth overrides other
configured authorization headers. Bearer auth and OAuth cannot both be configured.
`${NAME}` in `env`/`headers` interpolates the current environment. Missing explicit
environment references fail without revealing values; no secret is written by the
client. Configured HTTP headers are sent only to the MCP origin, never a different
OAuth discovery/token origin. Stdio stderr is discarded.

### Alternative JSON field names

Use either `servers` or `mcp_servers` as the root, not both. Individual entries
accept the following aliases, but never an alias together with its camelCase field:

| Alternative field | Harbor field |
| --- | --- |
| `startup_timeout_sec` | `startupTimeoutMs` (seconds converted to integer milliseconds) |
| `tool_timeout_sec` | `toolTimeoutMs` (seconds converted to integer milliseconds) |
| `enabled_tools` | `allowTools` |
| `disabled_tools` | `denyTools` |
| `env_vars` | `envVars` (string names only) |
| `http_headers` | `headers` |
| `env_http_headers` | `envHeaders` |
| `bearer_token_env_var` | `bearerTokenEnvVar` |

`command`, `args`, `env`, `url`, `cwd` and `enabled` use the same spelling.
Only JSON is supported. Unknown fields (including `required`, auth policies,
environment-source objects and header helpers) are errors, not silently ignored.
OAuth accepts `clientId` and `scope`. No external agent's config or credentials
are loaded. Previously ignored misspellings now fail validation.
Disabled entries must still be valid.

## Commands and tools

- `/mcp`: server state and eligible/registered tool counts, without credentials.
- `/mcp-connect SERVER`: connect or explicitly refresh the tool inventory.
- `/mcp-auth SERVER`: interactive OAuth authorization for this session.
- `mcp` tool `action: "servers"`: configured names (backward-compatible).
- `action: "status"`: per-server state and counts.
- `action: "resources"`, `"templates"`, `"prompts"`: bounded catalog listings.
- `action: "read"` plus `uri`: fetch a resource.
- `action: "prompt"` plus `name` and optional string `arguments`: get a prompt.

Enabled servers initialize at session startup, at most four concurrently.
Interactive consent prompts are serialized. Disabled servers never prompt or
start. One failed server does not prevent healthy servers from becoming available.
States are `disabled`, `disconnected`, `connecting`, `ready`, `failed`,
`auth_required`, and `closed`.

Each connection and action asks for consent by default. Turn cancellation dismisses
active consent dialogs and skips queued prompts without dispatching their actions.
Headless sessions fail
closed unless `consent: "allow"` explicitly authorizes that configured server.
Use `allowTools` to narrow tool authority; `denyTools` always wins. Lists match
exact raw names, not generated Pi names or glob patterns. Empty allow-list means
no tools. Filters apply to discovery and calls. Resource/prompt access remains
independent of tool filtering. Remote `readOnlyHint` annotations never authorize
actions. Sampling and elicitation are not enabled.

Pi tool names preserve the existing sanitized server/tool name plus exact-name
hash. Valid input JSON Schemas are preserved, including nested constraints and
references. Oversized/deep/external-reference schemas are excluded with a warning;
provider-specific schema limitations may require further filtering. Duplicate raw
tool names fail discovery. Refresh invalidates old callbacks and deactivates
removed tools, then reactivates the configured eligible tools. Automatic
server-notification refresh is not supported. Reconnect after a server changes its
inventory. Late startup completion cannot register tools in a replacement session.

All server content is returned as bounded **untrusted data**, including prompts,
templates and tool-error diagnostics. Nothing is injected as instructions.
Resource templates are metadata only; callers construct an explicit URI for
`read`. Embedded images/binary content stay encoded in JSON.

## Deadlines and limits

- Startup: **10s** for handshake plus all initial tool-discovery pages.
- Tool/resource/prompt operations: **60s**, including every catalog page.
- `startupTimeoutMs`/`toolTimeoutMs` override their phase. Legacy `timeoutMs`
  supplies both unless overridden. All deadlines allow 10–120000ms. Progress
  cannot extend them.
- 32 servers; 32 pages and 256 items per listing; 64 KiB cursor maximum.
  Repeated cursors and exceeded bounds fail the entire listing, not partial success.
  Empty-string cursors are followed. Unadvertised catalog capabilities return `[]`.
- 64 KiB output default; `maxOutputBytes` allows 256–1048576 bytes. Truncation is
  explicit and full content is not hidden in tool details.
- 2 MiB HTTP JSON response, SSE event, or stdio frame before SDK parsing.
- 32 KiB schema, depth 32, local schema references only. String lists max 256 items.

Request cancellation uses the SDK's per-request MCP cancellation notification;
it does not imply a mutation was rolled back. Actions are never automatically
replayed. An HTTP/SSE response-size violation closes the connection and rejects
pending requests promptly; only a later explicit call may reconnect. A stdio exit
or frame overflow requires `/mcp-connect SERVER` and is reported as a disconnect. Session shutdown closes transports, reaps stdio
children, and aborts pending work. These are lifecycle controls, not an OS sandbox.

## OAuth

Run `/mcp-auth SERVER` and open the displayed URL manually. SDK authorization-code
flow handles discovery, PKCE and token refresh. The temporary callback listener
binds to `127.0.0.1`, validates state, and closes on completion, shutdown, or the
two-minute authorization deadline. Configured HTTP headers never accompany a
cross-origin authorization request; all fetches require HTTPS or loopback HTTP
and reject redirects. A pre-registered public client must allow loopback callbacks
with an ephemeral port. Omit `clientId` only for servers supporting dynamic
registration. Tokens and registration information last only for the Pi session;
re-authorize after reload. If automatic token refresh cannot recover authorization,
Harbor asks you to run `/mcp-auth` again instead of displaying a dead callback URL.
No browser opens automatically. Durable keyring storage,
first-party account auth and enterprise token exchange are not supported.

## Verification

`node --import tsx --test extensions/mcp-client/*.test.ts` runs local SDK stdio,
Streamable HTTP, legacy SSE and synthetic OAuth fixtures. Coverage includes
config normalization, deadlines, templates, cursor bounds, filters, progress,
out-of-order replies, server-observed cancellation, lifecycle cleanup, status,
stale inventories, trust changes, PKCE, origin-scoped credentials and output bounds.
No live remote account or production OAuth provider is needed or implied.
