# Subagent rejection and parent continuation

The Claude Code adapter can report:

```text
Pi history diverged from the active Claude Code conversation. Start a new session.
```

The responsible adapter is outside this repository. The cause of the reported
failure remains unknown. Connector delegation does not fix it or alter
transcript-integrity checks.

## Adapter reproduction recipe

Use a fresh Pi session with the same Claude Code adapter conversation throughout.
Register this synthetic parent connector as a trusted local extension:

```ts
import {Type} from 'typebox';
export default function fixture(pi) {
  pi.registerTool({
    name: 'claude_jira_get_issue', label: 'Fixture issue',
    description: 'Read synthetic issue FIXTURE-1', parameters: Type.Object({}),
    async execute() {
      return {content: [{type: 'text', text: 'FIXTURE-1'}], details: {}};
    },
  });
}
```

On revision `35653dafe1e3e957969e93fd76b1c6a5535ae9ad`, request:

```json
{
  "task": "Summarize synthetic issue FIXTURE-1",
  "tools": ["read", "bash", "claude_jira_get_issue"]
}
```

After `Invalid builtin tool selection`, send a second user message requesting a
plain-text acknowledgement. On this revision, omit the connector's delegation
grant to get `Disallowed connector tools`, then send the same acknowledgement
request. Neither sequence uses live Jira. The adapter error itself has not been
reproduced.

Capture the synthetic transcript before rejection, the error tool result, and
the next provider request. Record Pi/adapter versions, the Claude conversation
ID, message roles/content blocks, tool-call/result IDs, and error flags. Compare
the Pi projection with the adapter's stored prefix and identify the first
mismatching message. Redact credentials. Keep the integrity check enabled.

For ordinary Pi execution, the rejection and background-call regressions run
without a live adapter:

```sh
node --import tsx --test --test-name-pattern='rejected selection|another parent turn' tests/delegated-child-tools.test.ts
```

These tests do not reproduce the Claude adapter failure.

## Pi 0.99.1 nested-call accounting

Late calls through a captured `ctx.executeTool` context still use parent
validation and permission hooks. Pi removes the originating nested-call scope
when its tool result starts, and clears remaining scopes at `agent_end`. Late
calls can miss originating-result accounting and reuse nested-call IDs across
parent turns. Workflow calls stay inside their originating tool invocation.

To inspect that ID reuse, register a tool that captures its `ExtensionToolContext`
and returns immediately, plus a fake connector. Issue the capturing tool with
model tool-call ID `parent-call` and let the parent finish. Call
`capturedContext.executeTool("fake_connector", {})`, complete another parent
turn, then call it again. Compare both outcomes' `toolCall.id`; Pi 0.99.1 can
return `parent-call/1` for both.

The relevant upstream code is `core/nested-tool-calls.ts` and
`core/agent-session.ts`. This accounting limitation is separate from the
unreproduced Claude continuation failure.
