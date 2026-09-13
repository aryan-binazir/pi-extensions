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

An empty `{}` config means no servers. Otherwise use either `servers` or
`mcp_servers` as the root, not both. Individual entries
accept the following aliases, but never an alias together with its camelCase field:

| Alternative field | Harbor field |
| --- | --- |
| `startup_timeout_sec` | `startupTimeoutMs` (seconds must yield an integer number of milliseconds) |
| `tool_timeout_sec` | `toolTimeoutMs` (seconds must yield an integer number of milliseconds) |
| `enabled_tools` | `allowTools` |
| `disabled_tools` | `denyTools` |
| `env_vars` | `envVars` (string names only) |
| `http_headers` | `headers` |
| `env_http_headers` | `envHeaders` |
| `bearer_token_env_var` | `bearerTokenEnvVar` |

Other supported fields are `command`, `args`, `env`, `url`, `cwd`, `enabled`,
`transport`, `consent`, `timeoutMs`, `maxOutputBytes` and `oauth`.
Only JSON is supported. Unknown fields (including `required`, auth policies,
environment-source objects and header helpers) are errors, not silently ignored.
OAuth accepts `clientId` and `scope`. No external agent's config or credentials
are loaded. Previously ignored misspellings now fail validation.
Disabled entries must still be valid.

## Commands and tools

- `/mcp`: server state and eligible/registered tool counts, without credentials.
- `/mcp-connect SERVER`: connect or explicitly refresh the tool inventory using
  the current configuration snapshot. Config file edits require `/reload`.
- `/mcp-auth SERVER`: interactive OAuth authorization, saved in macOS Keychain on macOS; session-only elsewhere.
- `/mcp-forget SERVER`: disconnect and delete the current configuration's remembered connection approval and OAuth credentials. Other sessions observe deleted sign-in before their next OAuth request; `consent: "allow"` still explicitly permits connections/actions.
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

The first connection asks to **remember approval**. Later startups/reloads for the
same server configuration and config source reuse it. Approval is bound to the
full normalized configuration, resolved credentials/environment, and authority
(global, project directory, or explicit config path). Global HTTP approvals work
across projects; stdio approval also binds the effective working directory. Config
changes require approval again. Project trust is still checked on every action.
Only non-secret hashed approval records live under the agent directory's private
`harbor-mcp/approvals/` directory; OAuth secrets never go there.

Tool and resource actions **still ask for consent**: remembered connection consent
does not grant remote tool execution. Turn cancellation dismisses active dialogs
and skips queued prompts without dispatch. TUI and RPC can approve connections;
headless sessions can reuse remembered approval but cannot create it. Actions in
headless sessions still require explicit `consent: "allow"`, which authorizes both
connections and actions for that configured server.
Use `allowTools` to narrow tool authority; `denyTools` always wins. Lists match
exact raw names, not generated Pi names or glob patterns. Empty allow-list means
no tools. Filters apply to discovery and calls. Resource/prompt access remains
independent of tool filtering. Remote `readOnlyHint` annotations never authorize
actions. Sampling and elicitation are not enabled.

Pi tool names preserve the existing sanitized server/tool name plus exact-name
hash. Valid input JSON Schemas are preserved, including nested constraints and
references. Consent labels are single-line, control-free and bounded; tool names
also show their stable Pi identifier so truncated labels are distinguishable.
Oversized/deep/external-reference schemas are excluded with a warning;
provider-specific schema limitations may require further filtering. Duplicate raw
tool names fail discovery. Refresh invalidates old callbacks and deactivates
removed tools, then reactivates the configured eligible tools. Failed catalog
refresh closes the connection; reconnect explicitly to recover. An auth command
on a non-OAuth server does not retire its healthy inventory. Automatic
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
- 32 KiB schema, JSON-entry depth 32 (each `properties` object adds a level).
  Supported reference values are `#` and `#/...`, not named anchors. `$id` and
  `$schema` metadata are preserved; Harbor itself performs no URI resolution.
  String lists max 256 items. Unserializable/deep output is explicitly omitted.

Request cancellation uses the SDK's per-request MCP cancellation notification;
it does not imply a mutation was rolled back. Actions are never automatically
replayed. An HTTP/SSE response-size violation closes the connection and rejects
pending requests promptly; only a later explicit call may reconnect. A stdio exit
or frame overflow requires `/mcp-connect SERVER` and is reported as a disconnect. Session shutdown closes transports, reaps stdio
children, and aborts pending work. These are lifecycle controls, not an OS sandbox.

## OAuth

Run `/mcp-auth SERVER` once and open the displayed URL manually. On macOS, tokens
(including refresh tokens), client registration, and the original callback URI are
saved in **macOS Keychain**, scoped to the server identity above. Restart/reload
loads those credentials and the SDK refreshes them when needed, saving rotated
tokens. Credential-bearing requests are serialized per identity with an OS file
lock across Pi processes; each operation reloads current credentials under that
lock so stale sessions cannot reuse rotated tokens or recreate forgotten sign-in.
This also serializes concurrent OAuth tool calls for that identity. Shutdown
closes the connection and drains accepted credential writes without deleting
sign-in. Interactive login stages registration/tokens until it succeeds, so an
abandoned login does not overwrite the previous sign-in. Expired/revoked
authorization that cannot be refreshed asks you to sign in again; no browser opens
automatically. `/mcp` reports `oauthStorage` without exposing credentials.

The bundled Swift helper uses Apple's Security framework. It is compiled with
a matching Swift compiler/SDK from Xcode or Command Line Tools (`xcode-select
--install`) into a private, versioned `.harbor-mcp-oauth/` cache under Pi's agent
directory. Helper compilation honors `DEVELOPER_DIR`, otherwise prefers a full
Xcode installation at `/Applications/Xcode.app`, falling back to the selected
system toolchain if that preferred installation cannot compile; it does not change
the system's toolchain selection. Failed compilation can be retried in-session. macOS may ask you to allow
Keychain access to that helper (and again after a helper/compiler update). Secrets
travel only over bounded stdin/stdout pipes, never command-line arguments,
environment variables, or plaintext files. A locked/denied Keychain, unsafe cache,
missing compiler, or corrupt credential record fails closed with an actionable
error; there is no silent plaintext or session-only fallback on macOS. Keychain
access uses its own bounded wait (up to two minutes), outside the MCP handshake
deadline. Cancelling a request stops it from dispatching after a delayed load. On other
platforms OAuth remains session-only and warnings explicitly explain that limit.

The SDK handles discovery, PKCE and refresh. The temporary interactive callback
listener binds to `127.0.0.1`, validates state, and closes after login or shutdown;
authorization has a two-minute deadline. Restoring sign-in does not open a callback
listener. A new interactive login obtains a fresh dynamic registration rather
than reusing a registration tied to a different callback. PKCE verifiers and state
nonces are never persisted. A pre-registered client must support ephemeral
loopback callback ports; omit `clientId` only for servers supporting dynamic
registration. Configured headers never accompany cross-origin OAuth requests;
all fetches require HTTPS or loopback HTTP and reject redirects.

`/mcp-forget SERVER` removes local saved sign-in and connection consent for the
current configuration after draining local credential writes and acquiring the
shared identity lock. It does not revoke tokens at the provider or stop other Pi
processes; those processes reload the removed state before their next OAuth
request rather than persisting their old tokens again. Old identities after config
changes remain separate Keychain items (service `Harbor MCP OAuth`); remove them
through Keychain Access if no longer needed. First-party account auth and
enterprise token exchange are not supported.

## Verification

`node --import tsx --test extensions/mcp-client/*.test.ts` runs local SDK stdio,
Streamable HTTP, legacy SSE and synthetic OAuth fixtures. Coverage includes
config normalization, deadlines, templates, cursor bounds, filters, progress,
out-of-order replies, server-observed cancellation, lifecycle cleanup, status,
stale inventories, trust changes, PKCE, origin-scoped credentials and output bounds.
No live remote account or production OAuth provider is needed or implied.
