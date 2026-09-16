# ADR 007: Harbor MCP

Status: retired; superseded by [ADR 011](011-external-mcp-adapter.md).

This records the removed implementation, not the current adapter’s guarantees.

## Historical decision

Harbor MCP is Pi's bundled TypeScript MCP client. Use the official TypeScript MCP
SDK for protocol framing, transports, progress, cancellation and authentication;
keep Pi-specific configuration, consent and lifecycle behavior in the extension.
No separate adapter or additional runtime is needed. Existing `mcp` tool names,
commands and the bundled client entrypoint remained compatible.

Third-party attribution and licenses are in [`../licenses`](../licenses).

## Structure

- `config.ts`: strict JSON normalization, whole-entry merging, per-phase timeout
  settings, cwd/env/header resolution, and exact raw-name tool allow/deny lists.
- `client.ts`: SDK transport ownership, server status, OAuth, request deadlines,
  bounded responses and capability-aware resource/template/prompt access.
- `pagination.ts`: common catalog collection with whole-operation deadlines,
  repeated/oversized cursor detection, item/page bounds and ordered results.
- `index.ts`: Pi tools and commands, startup scheduling, serialized consent,
  project trust, schema eligibility and session-scoped tool inventories.

## Boundaries

- Only JSON is read. Unknown fields, conflicting aliases, unsupported policies
  and invalid transport fields fail closed. No external agent's config or
  credentials are loaded. The former extension README documented accepted field names.
- No enterprise token exchange, remote execution environments, header-helper
  commands, plugin imports, persistent catalog cache, `required`/exec-exit policy,
  sampling or elicitation. Resource templates are not automatically expanded.
  Tool-inventory changes require explicit `/mcp-connect SERVER` refresh.
- OAuth credentials persist in macOS Keychain through a bundled native Security
  framework helper; other platforms retain session-only OAuth. The SDK owns PKCE,
  discovery and token refresh. Compiler/Keychain failures fail closed, never to
  plaintext storage. No browser opens automatically. Callback ports remain
  ephemeral; persisted registration/redirect metadata supports passive refresh,
  while a new interactive login obtains a fresh dynamic registration.
- Initial connection approval is remembered in private non-secret, hashed records.
  Both approval and Keychain identity bind the full normalized config, effective
  environment/headers, and config authority. Global HTTP identity is reusable
  across projects; stdio additionally binds cwd. Config/source changes require new
  approval. Tool/resource consent and project trust remain mandatory by default,
  including after awaits. `/mcp-forget` disconnects and removes saved state for the
  current identity without revoking provider tokens. Cross-process identity leases
  serialize OAuth operations, reload state before requests, and coordinate forget
  with refresh so stale sessions cannot overwrite rotated tokens or recreate a
  forgotten identity. Interactive login stages changes until success, and normal
  shutdown drains accepted writes. Keychain access has a separate bounded wait
  outside the network handshake deadline.
  Four startup workers share one serialized interactive consent queue. Disabled
  servers are validated but never connected or prompted. A failure does not stop
  healthy servers. Status excludes configuration, environment values and headers.
- Refresh invalidates old callbacks and deactivates removed tools. Pi has no
  unregister API, so execution also checks inventory identity. Reconnect exposes
  the configured eligible tools. Session replacement, shutdown and project
  directory/trust changes cannot reuse old authority.
- Bounds: 32 servers, 32 pages and 256 items per catalog, 64 KiB cursors, 2 MiB
  responses/events/frames, 32 KiB schemas, JSON-entry depth 32 and reference
  values limited to `#`/`#/...` (not named anchors). No URI resolver is installed.
  Duplicate tool names fail discovery rather than registering ambiguous schemas.
  Catalog failures never return partial success. An empty cursor is followed;
  only an absent cursor completes pagination. Missing capabilities return `[]`.
- Defaults: 10s startup (handshake plus initial discovery), 60s actions (including
  every catalog page). Explicit `timeoutMs` preserves the shared-budget setting;
  phase-specific fields take precedence. Progress cannot extend deadlines.
  Configurable timeout bounds are 10–120000ms.
- Never replay failed tool mutations. A new explicit action may reconnect after
  an HTTP/SSE response-size reset; transport exits otherwise require explicit reconnect.
  Cancellation sends MCP cancellation but cannot undo remote side effects.
- Stdio processes run with the user's OS permissions. Harbor is not a sandbox;
  verification containers are test infrastructure, not a runtime security
  guarantee. Cwd/env/header authority is user-selected, not server-selected.
  Missing explicit environment references fail closed.

## Verification

The regression suite covers all three transports, paginated templates, startup
and call deadlines, server-observed cancellation, stdio environment/cwd and cleanup,
config aliases/conflicts, unsupported policies, cursor cycles, duplicate tools,
capability-aware catalogs, sanitized status, consent serialization, trust/session
changes during prompts, late startup completion, stale schemas, output limits,
header-origin isolation and synthetic OAuth PKCE.

During verification, a throwaway harness exercised the actual transports and
extension registration boundary inside an ephemeral Node container with synthetic
credentials and no external network. That scratch harness is intentionally not
shipped. The former bundled-client integration tests were removed with the client. This does not prove live provider authentication, graphical
browser login, a real model conversation, or macOS behavior.
