# Subagent rejection and parent continuation

The reported sequence was a rejected tool selection followed by:

```text
Pi history diverged from the active Claude Code conversation. Start a new session.
```

That error text and the responsible Claude Code adapter are outside this
repository. The error's precise cause has not been established. Connector
delegation does not claim to fix it, and no transcript-integrity checks were
changed.

## Verified in this repository

`tests/delegated-child-tools.test.ts` uses real Pi sessions with deterministic
model responses, a fake connector, and supervised child processes. An unavailable
and ungranted selection returns a normal `toolResult` with `isError: true`. The
parent then calls another tool successfully. A permitted connector also executes
after the background spawn result and another parent turn. This verifies Pi's
ordinary execution path, not the live Claude Code adapter's continuation path.

Run the reproduction without Jira access:

```sh
node --import tsx --test --test-name-pattern='rejected selection|another parent turn' tests/delegated-child-tools.test.ts
```

## Minimal adapter reproduction to investigate

Use a fresh throwaway Pi session and a fake registered connector. Keep the same
Claude Code adapter conversation for both requests. On the pre-fix revision,
request a child with:

```json
{
  "task": "Summarize synthetic issue FIXTURE-1",
  "tools": ["read", "bash", "claude_jira_get_issue"]
}
```

After `Invalid builtin tool selection`, send a second user message asking for a
plain-text acknowledgement. On this revision, omit the connector's delegation
grant to get a deterministic `Disallowed connector tools` rejection, then send
the same acknowledgement request. Neither sequence needs live Jira access.

For the adapter maintainer, capture a redacted synthetic transcript immediately
before rejection, its error tool result, and the next provider request. Record
Pi and adapter versions, the active Claude conversation ID, message roles and
content blocks, tool-call IDs, result IDs, error flags, and the first differing
message between the Pi projection and the adapter's stored prefix. Compare
whether the thrown tool error or the subsequent user message changes that prefix.
Do not suppress the integrity check or use a real private issue as the fixture.
This is a reproduction recipe; the live adapter failure remains unverified.

## Separate Pi 0.99.1 bookkeeping limitation

The public `ctx.executeTool` API still executes through parent validation and
permission hooks after its originating background tool has returned. Pi attaches
nested-call records when that tool's result starts, removes that scope, and clears
remaining scopes at `agent_end`. A late call can therefore miss its originating
result's accounting. A local probe also observed `parent-call/1` for two calls
made through the same captured context on opposite sides of another parent turn.

To reproduce that ID reset, register a tool that captures its `ExtensionToolContext`
and returns immediately, plus a fake connector. Issue the capturing tool through
a normal model tool call with ID `parent-call`, let the parent finish, then call
`capturedContext.executeTool("fake_connector", {})`. Complete another parent
turn and call the same captured context again. Inspect both outcomes' `toolCall.id`.
Both were `parent-call/1` in the inspected Pi 0.99.1 installation.

The relevant Pi code is `core/nested-tool-calls.ts` scope creation,
`core/agent-session.ts` nested record removal and `agent_end` cleanup. This is a
separate observed limitation, not evidence that it caused the Claude rejection
continuation failure. The extension leaves this bookkeeping intact.
