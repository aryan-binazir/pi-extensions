import assert from "node:assert/strict";
import test from "node:test";
import btw from "./index.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

function host(chunks: any[] = [{ type: "text_delta", delta: "Side answer" }]) {
  const commands: Record<string, any> = {};
  const hooks: Record<string, any> = {};
  const requests: any[] = [];
  let renderRequests = 0;
  let component: any;
  const terminal = { rows: 40, columns: 80 };
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
        assert.equal(options.overlayOptions.offsetY, -1);
        return new Promise((resolve) => {
          component = factory(
            { requestRender() { renderRequests++; }, terminal },
            {
              fg: (_: string, value: string) => value,
              bg: (color: string, value: string) => {
                assert.equal(color, "userMessageBg");
                return `\x1b[48;5;236m${value}\x1b[49m`;
              },
            },
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
    get renderRequests() { return renderRequests; },
    terminal,
    lines: (width = 80): string[] => component.render(width),
    key: (s: string) => component.handleInput(s),
    render: () => component.render(80).join("\n"),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("BTW fills its overlay from opening through the first answer and resize", async () => {
  const h = host();
  const result = h.commands.btw.handler("", h.ctx);
  assert.equal(h.lines().length, 36);
  assert.match(h.lines()[0], /^┌─+┐$/);
  assert.match(h.render(), /Side conversation · disposable/);
  assert.doesNotMatch(h.render(), /\bBTW\b/);
  assert.match(h.lines().at(-1)!, /^└─+┘$/);
  assert.ok(h.lines().every((line) => visibleWidth(line) === 80));
  h.key("First question");h.key("\r");
  assert.equal(h.lines().length, 36);
  await tick();
  assert.equal(h.lines().length, 36);
  assert.match(h.render(), /Side answer/);
  assert.doesNotMatch(h.render(), /Enter a followup/);
  for (const rows of [60, 20, 5, 1]) {
    h.terminal.rows = rows;
    assert.equal(h.lines(20).length, Math.max(1, Math.floor(rows * 0.9)));
  }
  h.key("\u001b");await result;
});

test("BTW keeps the input area in place while connecting and streaming", async () => {
  const h = host();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  h.ctx.modelRegistry.getProvider = () => ({
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "Partial answer" };
        await waiting;
      },
    }),
  });
  const result = h.commands.btw.handler("", h.ctx);
  const inputArea = h.lines().slice(-3);
  h.key("Question");h.key("\r");
  assert.match(h.render(), /Connecting/);
  assert.deepEqual(h.lines().slice(-3), inputArea);
  await tick();
  assert.match(h.render(), /Partial answer/);
  assert.match(h.render(), /Answering/);
  assert.deepEqual(h.lines().slice(-3), inputArea);
  finish();await tick();
  assert.deepEqual(h.lines().slice(-3), inputArea);
  h.key("\u001b");await result;
});

test("BTW requests an Answering repaint before the first stream event", async () => {
  const h = host();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  h.ctx.modelRegistry.getProvider = () => ({
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        await waiting;
        yield { type: "text_delta", delta: "Delayed answer" };
      },
    }),
  });
  const result = h.commands.btw.handler("Question", h.ctx);
  const beforeAnswering = h.renderRequests;
  await tick();
  assert.ok(h.renderRequests > beforeAnswering);
  assert.match(h.render(), /Answering…/);
  assert.doesNotMatch(h.render(), /Delayed answer/);
  finish();await tick();
  h.key("\u001b");await result;
});

test("BTW shows the full side transcript and queues followups without losing a draft", async () => {
  const h = host();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const requests: any[] = [];
  h.ctx.modelRegistry.getProvider = () => ({
    streamSimple: (_model: any, context: any) => {
      const index = requests.push(context);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", delta: index === 1 ? "First answer" : "Second answer" };
          if (index === 1) await waiting;
        },
      };
    },
  });
  const result = h.commands.btw.handler("First question", h.ctx);
  assert.match(h.render(), /First question/);
  await tick();
  h.key("Second question");
  assert.match(h.render(), /Second question/);
  h.key("\r");
  assert.match(h.render(), /\(queued\)/);
  assert.ok(h.lines().find((line) => line.includes("Second question"))?.includes("\x1b[48;5;236m"));
  assert.equal(requests.length, 1);
  h.key("Unsent draft");
  finish();await tick();await tick();
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /First question/);
  assert.match(JSON.stringify(requests[1].messages), /First answer/);
  const transcript = h.render();
  for (const text of ["First question", "First answer", "Second question", "Second answer", "Unsent draft"])
    assert.ok(transcript.includes(text), text);
  assert.doesNotMatch(transcript, /queued/);
  h.key("\u001b");await result;
});

test("BTW omits model history when all earlier queued turns failed", async () => {
  const h = host([
    { type: "error", error: { errorMessage: "synthetic failure" } },
  ]);
  const result = h.commands.btw.handler("First question", h.ctx);
  h.key("Queued question");h.key("\r");
  await tick();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].context.messages.map((message: any) => message.content), [
    "Conversation snapshot:\n", "Queued question",
  ]);
  assert.match(h.render(), /Side request failed: synthetic failure/);
  assert.doesNotMatch(h.render(), /\(No answer\)/);
  h.key("\u001b");await result;
});

for (const failure of ["auth", "stream", "partial stream"]) {
  test(`BTW keeps ${failure} failures visible across queued turns and out of model history`, async () => {
    const h = host();
    const result = h.commands.btw.handler("Successful question", h.ctx);
    await tick();
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => { fail = resolve; });
    let connect!: () => void;
    const connecting = new Promise<void>((resolve) => { connect = resolve; });
    let authCalls = 0;
    h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      if (++authCalls === 1 && failure === "auth") {
        await failing;
        return { ok: false, error: "synthetic failure" };
      }
      if (authCalls === 2) await connecting;
      return { ok: true, apiKey: "synthetic-key" };
    };
    h.ctx.modelRegistry.getProvider = () => ({
      streamSimple: (_model: any, context: any, options: any) => {
        h.requests.push({ context, options });
        const shouldFail = authCalls === 1;
        return {
          async *[Symbol.asyncIterator]() {
            if (shouldFail) {
              if (failure === "partial stream")
                yield { type: "text_delta", delta: "Unfinished reply" };
              await failing;
              yield { type: "error", error: { errorMessage: "synthetic failure" } };
            } else {
              yield { type: "text_delta", delta: "Queued answer" };
            }
          },
        };
      },
    });
    h.key("Failed question");h.key("\r");
    await tick();
    h.key("Queued question");h.key("\r");
    fail();await tick();
    assert.match(h.render(), /Connecting/);
    assert.match(h.render(), /Side request failed: synthetic failure/);
    assert.doesNotMatch(h.render(), /\(No answer\)/);
    if (failure === "partial stream") assert.match(h.render(), /Unfinished reply/);
    connect();await tick();
    const history = h.requests.at(-1).context.messages.filter((message: any) =>
      message.content.startsWith("Earlier side conversation:"));
    assert.deepEqual(history.map((message: any) => message.content), [
      "Earlier side conversation:\nUser: Successful question\nAssistant: Side answer",
    ]);
    assert.equal(h.requests.at(-1).context.messages.at(-1).content, "Queued question");
    assert.match(h.render(), /Side request failed: synthetic failure/);
    assert.match(h.render(), /Queued answer/);
    h.key("\u001b");await result;
  });
}

test("side chat uses normal user backgrounds and Agent labels while streaming and completed", async () => {
  const h = host();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  h.ctx.modelRegistry.getProvider = () => ({
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "**Assistant reply**" };
        await waiting;
      },
    }),
  });
  const result = h.commands.side.handler("User question\nSecond line", h.ctx);
  const check = () => {
    for (const width of [80, 24]) {
      const lines = h.lines(width);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      for (const text of ["User question", "Second line"]) {
        const line = lines.find((line) => line.includes(text));
        assert.ok(line?.includes("\x1b[48;5;236m"), text);
        assert.match(line!, /\x1b\[49m│$/);
      }
      const reply = lines.find((line) => stripTerminalSequences(line).includes("Assistant reply"));
      assert.ok(reply);
      assert.ok(!reply.includes("\x1b[48;5;236m"));
      const label = lines.find((line) => stripTerminalSequences(line).includes("Agent:"));
      assert.ok(label, "assistant reply is labeled Agent:");
      assert.ok(!label.includes("\x1b[48;5;236m"));
      assert.doesNotMatch(stripTerminalSequences(lines.join("\n")), /You:|\bBTW\b|Assistant:|\*\*/);
    }
  };
  await tick();
  check();
  finish();await tick();
  check();
  h.key("\u001b");await result;
});

test("closing BTW discards queued messages", async () => {
  const h = host();
  let authenticate!: (value: any) => void;
  h.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => { authenticate = resolve; });
  const result = h.commands.btw.handler("First", h.ctx);
  h.key("Queued");h.key("\r");
  h.key("\u001b");await result;
  authenticate({ ok: true, apiKey: "synthetic-key" });await tick();
  assert.equal(h.requests.length, 0);
});

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

test("missing or invalid model output limits still use a positive bounded token budget", async () => {
  for (const maxTokens of [undefined, 0, -1, NaN]) {
    const h = host();
    h.ctx.model.maxTokens = maxTokens;
    const result = h.commands.btw.handler("Question", h.ctx);
    await tick();
    assert.equal(h.requests[0].options.maxTokens, 4096);
    h.key("\u001b");
    await result;
  }
});

test("an oversized followup stays editable and can be shortened without retyping", async () => {
  const h = host();
  const result = h.commands.btw.handler("", h.ctx);
  h.key("\u001b[200~" + "x".repeat(16001) + "\u001b[201~");
  h.key("\r");
  assert.match(h.render(), /Question exceeds 16000/);
  assert.equal(h.requests.length, 0);
  h.key("\u007f");
  h.key("\r");
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].context.messages.at(-1).content.length, 16000);
  h.key("\u001b");
  await result;
});
test("BTW strips residual terminal reset controls from provider output", async () => {
  const h = host([{ type: "text_delta", delta: "safe\x1bcRESET\x07\x9b31mtext" }]);
  const running = h.commands.btw.handler("Question", h.ctx);
  await tick();
  assert.ok(!h.render().includes("\x1bc"));
  assert.ok(!h.render().includes("\x07"));
  assert.ok(!h.render().includes("\x9b"));
  h.key("\x1b");
  await running;
});

test("paging past the top of a long side transcript stops on the first turn", async () => {
  const h = host([{ type: "text_delta", delta: "answer line\n\n".repeat(40) }]);
  const result = h.commands.btw.handler("First question", h.ctx);
  await tick();
  for (const question of ["Second question", "Third question", "Fourth question"]) {
    h.key(question);
    h.key("\r");
    await tick();
  }
  const bottom = h.render();
  for (let i = 0; i < 40; i++) h.key("\x1b[5~");
  const top = h.render();
  assert.match(top, /First question/);
  assert.doesNotMatch(top, /Fourth question/);
  assert.equal(h.lines().length, 36);
  // Paging back down only lands on the newest lines if the run past the top was
  // clamped to the real transcript height rather than left to run away.
  for (let i = 0; i < 40; i++) h.key("\x1b[6~");
  assert.equal(h.render(), bottom);
  h.key("\x1b");
  await result;
});

test("a repainted transcript follows the answer as it streams in", async () => {
  const h = host();
  let push!: () => void;
  const gate = new Promise<void>((resolve) => {
    push = resolve;
  });
  h.ctx.modelRegistry.getProvider = () => ({
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "alpha " };
        await gate;
        yield { type: "text_delta", delta: "omega" };
      },
    }),
  });
  const result = h.commands.btw.handler("Question", h.ctx);
  await tick();
  assert.match(h.render(), /alpha/);
  assert.doesNotMatch(h.render(), /omega/);
  push();
  await tick();
  assert.match(h.render(), /alpha omega/);
  h.key("Second question");
  h.key("\r");
  await tick();
  const transcript = h.render();
  assert.match(transcript, /alpha omega/);
  assert.match(transcript, /Second question/);
  h.key("\x1b");
  await result;
});
