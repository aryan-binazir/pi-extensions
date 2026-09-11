# MCP client

Enable `extensions/mcp-client/index.ts`. This adapter uses the official TypeScript MCP SDK for protocol framing, request IDs, transport authentication, cancellation and progress. Pi reasons about tool results. Server requests to sample another model or elicit credentials are not enabled.

Configuration merges the `servers` maps in this order, replacing each complete server entry:

1. `mcp.json` in Pi's agent directory, normally `~/.pi/agent/mcp.json`.
2. `.pi/mcp.json` in a trusted project. Untrusted project files are not read.
3. The explicit `--mcp-config /path/to/mcp.json` file.

An override preserves unrelated servers. Replacing an entry does not inherit the previous command, headers, environment or consent. Explicit config is a user-selected trust boundary. Project trust is checked again before every action.

```json
{
  "servers": {
    "local": {
      "command": "/absolute/path/to/mcp-server",
      "args": ["--stdio"],
      "env": {"SERVICE_TOKEN": "${SERVICE_TOKEN}"},
      "allowTools": ["lookup"],
      "denyTools": ["delete"],
      "consent": "ask",
      "timeoutMs": 15000,
      "maxOutputBytes": 65536
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "transport": "http",
      "headers": {"Authorization": "Bearer ${MCP_TOKEN}"}
    },
    "legacy": {
      "url": "https://legacy.example.com/sse",
      "transport": "sse"
    },
    "oauth": {
      "url": "https://oauth.example.com/mcp",
      "oauth": {"clientId": "pre-registered-public-client", "scope": "read"}
    }
  }
}
```

`http` means Streamable HTTP. Legacy SSE is selected explicitly; authentication failures never trigger a transport fallback. URLs require HTTPS except loopback HTTP for local services. Credential-bearing transport requests reject redirects. Stdio receives the SDK's minimal inherited environment plus configured values, and its stderr is discarded. `${NAME}` resolves an existing environment variable without printing it. No credentials are written to disk or Pi's provider authentication store.

Every server connection and action asks for consent by default. Headless sessions fail closed. Setting `consent: "allow"` explicitly authorizes the configured server and its exposed actions for this extension; use `allowTools` to narrow tools. `denyTools` takes precedence. Resource and prompt access remains available independently of tool filtering. Auto-mode performs its own Pi `tool_call` checks even when MCP configuration allows an action. Remote `readOnlyHint` annotations never authorize actions or create local auto-mode declarations.

`/mcp-connect SERVER` connects or refreshes the discovered tools. Names include sanitized server/tool text and a hash of their exact names. The original input JSON Schema is preserved, including nested constraints and references. Provider limitations on JSON Schema remain provider limitations; this adapter does not silently weaken a schema.

The `mcp` tool supports `servers`, `resources`, `read`, `prompts` and `prompt` actions. `read` takes a resource `uri`; `prompt` takes its `name` and optional string `arguments`. Prompts and resources are returned as untrusted data, never injected as instructions. Tool outputs use the same bounded JSON representation; embedded images and binary resources remain encoded in the JSON result.

For OAuth, run `/mcp-auth SERVER`, then open the displayed URL in your browser. The SDK discovers authorization metadata and uses authorization-code flow with PKCE. A temporary listener bound to `127.0.0.1` validates callback state. It closes after success, cancellation, shutdown or a two-minute deadline. Omit `clientId` only when the server supports dynamic registration. Pre-registered clients must permit loopback redirect URIs with an ephemeral port. Tokens and registration information last only for this Pi session. Authorization must be repeated after reload. No browser opens automatically.

Limits are 32 configured servers, 256 tools/resources/prompts per listing, 32 listing pages, a 15-second request deadline by default, and 64 KiB of output per result by default. Request deadlines allow 10–120000 ms; result limits allow 256–1048576 bytes. Stdio framing rejects messages above 2 MiB. Results are visibly truncated and never retained unbounded in tool details. Closing a session closes transports and reaps stdio children. Cancellation sends the SDK's request-specific cancellation notification; it does not imply a remote mutation was undone. Mutating requests are never retried by this adapter.

Verification uses local SDK stdio, stateful Streamable HTTP and legacy SSE fixtures, plus synthetic OAuth servers. It covers tools, exact schemas, resources, prompts, progress, out-of-order request completion, server-observed cancellation, auth errors, PKCE, state rejection, trust revocation and process cleanup. No live remote account or production OAuth provider was exercised.

HTTP JSON responses and individual SSE events are capped at 2 MiB before SDK parsing, matching the stdio frame bound. Remote schemas larger than 32 KiB, deeper than 32 levels, or containing nonlocal references are excluded with a warning. Other schemas are preserved; provider-specific JSON Schema restrictions can still require excluding an incompatible tool with `denyTools` or `allowTools`.

A response-size violation closes that connection and promptly rejects its pending requests with a size error. Failed actions are never replayed automatically. A later explicit tool/resource request may establish a fresh session, including legacy SSE; other pending operations must be inspected before deciding whether to retry them.
