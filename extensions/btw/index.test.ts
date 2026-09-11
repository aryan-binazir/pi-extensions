import assert from "node:assert/strict";
import test from "node:test";
import btw from "./index.ts";

function host(chunks: any[] = [{ type: "text_delta", delta: "Side answer" }]) {
  const commands: Record<string, any> = {};
  const hooks: Record<string, any> = {};
  const requests: any[] = [];
  let component: any;
  const ctx: any = {
    mode: "tui",
    model: { id: "fake", provider: "fake", maxTokens: 8192 },
    getSystemPrompt: () => "Current system",
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-key" }),
      getProvider: () => ({
        streamSimple: (_model: any, context: any, options: any) => {
          requests.push({ context, options });
          return {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) yield chunk;
            },
          };
        },
      }),
    },
    ui: {
      notify() {},
      custom: (factory: any, options: any) => {
        assert.equal(options.overlay, true);
        return new Promise((resolve) => {
          component = factory(
            { requestRender() {}, terminal: { rows: 40, columns: 80 } },
            { fg: (_: string, value: string) => value },
            {},
            resolve,
          );
        });
      },
    },
  };
  btw({
    registerCommand: (name: string, command: any) => {
      commands[name] = command;
    },
    on: (name: string, hook: any) => {
      hooks[name] = hook;
    },
  } as any);
  return {
    ctx,
    commands,
    hooks,
    requests,
    key: (s: string) => component.handleInput(s),
    render: () => component.render(80).join("\n"),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("BTW streams a tool-free side answer with current system snapshot and followups", async () => {
  const h = host();
  const result = h.commands.btw.handler("What about this?", h.ctx);
  await tick();
  assert.match(h.render(), /Side answer/);
  assert.equal(
    h.requests[0].context.systemPrompt.includes("Current system"),
    true,
  );
  assert.deepEqual(h.requests[0].context.tools, []);
  assert.equal(h.requests[0].options.apiKey, "synthetic-key");
  h.key("And then?");
  h.key("\r");
  await tick();
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[1].context.messages), /Side answer/);
  h.key("\u001b");
  await result;
  assert.equal(h.requests[1].options.signal.aborted, true);
});
test("snapshot honors retained-tail compaction and serializes tool results as inert text", async () => {
  const h = host();
  h.ctx.sessionManager.getBranch = () => [
    {
      id: "old",
      parentId: null,
      type: "message",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "FORGOTTEN ORIGINAL", timestamp: 1 },
    },
    {
      id: "compact",
      parentId: "old",
      type: "compaction",
      timestamp: "2026-01-01T00:00:01Z",
      summary: "COMPACT SUMMARY",
      tokensBefore: 5000,
      firstKeptEntryId: "old",
      retainedTail: [
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "TOOL RESULT TEXT" }],
          isError: false,
          timestamp: 2,
        },
      ],
    },
  ];
  const result = h.commands.side.handler("Explain", h.ctx);
  await tick();
  const request = h.requests[0].context;
  assert.match(JSON.stringify(request.messages), /COMPACT SUMMARY/);
  assert.match(JSON.stringify(request.messages), /TOOL RESULT TEXT/);
  assert.doesNotMatch(JSON.stringify(request.messages), /FORGOTTEN ORIGINAL/);
  assert.equal(
    request.messages.every((m: any) => m.role === "user"),
    true,
  );
  h.key("\u001b");
  await result;
});
test("close during authentication discards overlay and never starts provider request", async () => {
  const h = host();
  let resolveAuth: any;
  h.ctx.modelRegistry.getApiKeyAndHeaders = () =>
    new Promise((resolve) => {
      resolveAuth = resolve;
    });
  const result = h.commands.btw.handler("Question", h.ctx);
  h.key("\u001b");
  await result;
  resolveAuth({ ok: true });
  await tick();
  assert.equal(h.requests.length, 0);
});
test("provider failure stays in overlay; session shutdown aborts and closes", async () => {
  const h = host([
    { type: "error", error: { errorMessage: "synthetic provider failure" } },
  ]);
  const result = h.commands.btw.handler("Question", h.ctx);
  await tick();
  assert.match(h.render(), /synthetic provider failure/);
  h.hooks.session_shutdown();
  await result;
  assert.equal(h.requests[0].options.signal.aborted, true);
});
test("oversized provider output is bounded and aborts stream", async () => {
  const h = host([
    { type: "text_delta", delta: "x".repeat(40000) },
    { type: "text_delta", delta: "AFTER LIMIT" },
  ]);
  const result = h.commands.btw.handler("Question", h.ctx);
  await tick();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.match(h.render(), /Answer limit reached/);
  assert.doesNotMatch(h.render(), /AFTER LIMIT/);
  h.key("\u001b");
  await result;
});
test("provider terminal escape sequences are stripped from rendered text", async () => {
  const h = host([
    {
      type: "text_delta",
      delta: "safe\u001b]52;c;YXR0YWNr\u0007\u001b[2J answer",
    },
  ]);
  const result = h.commands.btw.handler("Question", h.ctx);
  await tick();
  const output = h.render();
  assert.doesNotMatch(output, /\u001b\]52|\u001b\[2J/);
  assert.match(output, /safe.*answer/);
  h.key("\u001b");
  await result;
});

test("legacy compaction excludes discarded messages and retains the tool-result tail", async () => {
  const h = host();
  h.ctx.sessionManager.getBranch = () => [
    {
      id: "old",
      parentId: null,
      type: "message",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "DISCARDED ORIGINAL", timestamp: 1 },
    },
    {
      id: "kept",
      parentId: "old",
      type: "message",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "KEPT RESULT" }],
        isError: false,
        timestamp: 2,
      },
    },
    {
      id: "compaction",
      parentId: "kept",
      type: "compaction",
      timestamp: "2026-01-01T00:00:02Z",
      summary: "LEGACY SUMMARY",
      tokensBefore: 5000,
      firstKeptEntryId: "kept",
    },
  ];
  const result = h.commands.btw.handler("Explain", h.ctx);
  await tick();
  const messages = JSON.stringify(h.requests[0].context.messages);
  assert.match(messages, /LEGACY SUMMARY/);
  assert.match(messages, /KEPT RESULT/);
  assert.doesNotMatch(messages, /DISCARDED ORIGINAL/);
  h.key("\u001b");
  await result;
});
