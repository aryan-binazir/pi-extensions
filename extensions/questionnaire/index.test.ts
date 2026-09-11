import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import questionnaire from "./index.ts";

test("questionnaire single option returns a typed answer and clears waiting", async () => {
  let tool: any;
  const events: any[] = [];
  questionnaire({
    registerTool: (t: any) => {
      tool = t;
    },
    on() {},
    events: { emit: (...args: any[]) => events.push(args) },
  } as any);
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender() {} },
            { fg: (_: string, s: string) => s },
            {},
            resolve,
          );
          component.handleInput("\r");
        }),
    },
  };
  const result = await tool.execute(
    "call-1",
    {
      questions: [
        {
          id: "scope",
          prompt: "Scope?",
          options: [{ value: "one", label: "One" }],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(result.details.answers, [
    { id: "scope", value: "one", label: "One", wasCustom: false },
  ]);
  assert.deepEqual(
    events.map((e) => e[1].waiting),
    [true, false],
  );
});

function host(onEmit?: (value: any) => void) {
  let tool: any;
  let component: any;
  const events: any[] = [];
  const hooks: Record<string, any> = {};
  questionnaire({
    registerTool: (t: any) => {
      tool = t;
    },
    on: (name: string, fn: any) => {
      hooks[name] = fn;
    },
    events: {
      emit: (_: string, value: any) => {
        events.push(value);
        onEmit?.(value);
      },
    },
  } as any);
  const ctx: any = {
    mode: "tui",
    ui: {
      custom: (factory: any) =>
        new Promise((resolve) => {
          component = factory(
            { requestRender() {} },
            { fg: (_: string, s: string) => s },
            {},
            resolve,
          );
        }),
    },
  };
  return {
    events,
    hooks,
    ctx,
    run: (questions: any[], signal?: AbortSignal) =>
      tool.execute("id", { questions }, signal, undefined, ctx),
    key: (key: string) => component.handleInput(key),
    render: (width = 60) => component.render(width),
  };
}
const question = (id: string) => ({
  id,
  prompt: `Choose ${id}`,
  options: [{ value: "yes", label: "Yes" }],
});
test("multiple questions require final submit and keep free text", async () => {
  const h = host();
  const result = h.run([question("a"), question("b")]);
  h.key("\r");
  h.key("\u001b[B");
  h.key("\r");
  h.key("custom answer");
  h.key("\r");
  assert.match(h.render().join("\n"), /Enter to submit all answers/);
  h.key("\r");
  assert.deepEqual((await result).details.answers, [
    { id: "a", value: "yes", label: "Yes", wasCustom: false },
    {
      id: "b",
      value: "custom answer",
      label: "custom answer",
      wasCustom: true,
    },
  ]);
});
test("cancel discards partial answers, abort and shutdown release waiting state", async () => {
  for (const action of ["escape", "abort", "shutdown"]) {
    const h = host();
    const controller = new AbortController();
    const result = h.run([question("a"), question("b")], controller.signal);
    h.key("\r");
    if (action === "escape") h.key("\u001b");
    if (action === "abort") controller.abort();
    if (action === "shutdown") h.hooks.session_shutdown();
    assert.equal((await result).details.cancelled, true);
    assert.deepEqual((await result).details.answers, []);
    assert.deepEqual(
      h.events.map((e) => e.waiting),
      [true, false],
    );
  }
});
test("UI exception releases waiting; noninteractive and invalid questions never wait", async () => {
  const h = host();
  h.ctx.ui.custom = () => {
    throw new Error("UI unavailable");
  };
  assert.match((await h.run([question("a")])).details.reason, /UI unavailable/);
  assert.deepEqual(
    h.events.map((e) => e.waiting),
    [true, false],
  );
  h.ctx.mode = "rpc";
  assert.equal((await h.run([question("a")])).details.cancelled, true);
  h.ctx.mode = "tui";
  assert.equal(
    (await h.run([question("a"), question("a")])).details.cancelled,
    true,
  );
});

test("concurrent calls cannot replace the active questionnaire and cancellation settles once", async () => {
  const h = host();
  const first = h.run([question("a")]);
  try {
    const second = await Promise.race([
      h.run([question("b")]),
      new Promise<undefined>((resolve) => setTimeout(resolve, 30)),
    ]);
    assert.ok(second, "A second caller must be rejected immediately");
    assert.equal(second.details.cancelled, true);
    assert.match(second.details.reason, /already active/);
    h.key("\u001b");
    h.key("\u001b");
    assert.equal((await first).details.cancelled, true);
    assert.deepEqual(
      h.events.map((e) => e.waiting),
      [true, false],
    );
    const next = h.run([question("c")]);
    h.key("\r");
    assert.equal((await next).details.answers[0].id, "c");
  } finally {
    h.hooks.session_shutdown();
  }
});

test("a failed waiting notification does not wedge later questionnaires", async () => {
  let fail = true;
  const h = host((value) => {
    if (value.waiting && fail) {
      fail = false;
      throw new Error("Synthetic emit failure");
    }
  });
  const rejected = await h.run([question("a")]);
  assert.equal(rejected.details.cancelled, true);
  assert.match(rejected.details.reason, /Synthetic emit failure/);
  const next = h.run([question("b")]);
  h.key("\r");
  assert.equal((await next).details.answers[0].id, "b");
  assert.deepEqual(
    h.events.map((e) => e.waiting),
    [true, false, true, false],
  );
});

test("free-only questions retain rejected long input for editing", async () => {
  const h = host();
  const pending = h.run([{ id: "free", prompt: "Write", options: [] }]);
  try {
    h.key("\r");
    h.key("\u001b[200~" + "x".repeat(16001) + "\u001b[201~");
    h.key("\r");
    assert.equal(h.events.length, 1, "An oversized answer must not submit");
    h.key("\u007f");
    h.key("\r");
    const result = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setTimeout(resolve, 30)),
    ]);
    assert.ok(result, "Rejected text should remain available to shorten");
    assert.equal(result.details.answers[0].value.length, 16000);
    assert.equal(result.details.answers[0].wasCustom, true);
  } finally {
    h.hooks.session_shutdown();
  }
});

test("option-only navigation clamps and never opens free text", async () => {
  const h = host();
  const pending = h.run([{ ...question("a"), allowOther: false }]);
  h.key("\u001b[A");
  h.key("\u001b[B");
  h.key("\u001b[B");
  h.key("\r");
  assert.deepEqual((await pending).details.answers, [
    { id: "a", value: "yes", label: "Yes", wasCustom: false },
  ]);
});

test("Pi's real custom UI bridge tolerates abort before the factory returns", async () => {
  const h = host();
  const controller = new AbortController();
  const added: unknown[] = [];
  const editor = { getText: () => "saved draft", setText() {} };
  const terminal = {
    requestRender() {},
    setFocus() {},
    terminal: { rows: 30, columns: 80 },
  };
  const bridgeHost = {
    editor,
    editorContainer: {
      clear() {},
      addChild(value: unknown) {
        added.push(value);
      },
    },
    ui: terminal,
    keybindings: {},
  };
  // Exercise the installed Pi UI boundary with a synthetic terminal. The private
  // bridge is used only by this compatibility regression, never by extensions.
  const bridge = (InteractiveMode.prototype as any).showExtensionCustom;
  h.ctx.ui.custom = (factory: any) =>
    bridge.call(bridgeHost, (...args: any[]) => {
      controller.abort();
      const component = factory(...args);
      h.hooks.session_shutdown(); // A second close cannot change the first result.
      return component;
    });
  const result = await h.run([question("a")], controller.signal);
  await Promise.resolve();
  assert.equal(result.details.cancelled, true);
  assert.deepEqual(
    added,
    [editor],
    "The cancelled questionnaire must never be attached",
  );
  assert.deepEqual(
    h.events.map((e) => e.waiting),
    [true, false],
  );
});
test("long option lists keep the selected answer inside a bounded viewport", async () => {
  const h = host();
  const running = h.run([{ id: "long", prompt: "Choose an option", allowOther: false,
    options: Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `Option-${i}`, description: "x".repeat(100) })) }]);
  for (let i = 0; i < 20; i++) {
    const rows = h.render(80);
    assert.ok(rows.length <= 24, `rendered ${rows.length} rows`);
    assert.ok(rows.join("\n").includes(`> Option-${i}`));
    h.key("\x1b[B");
  }
  h.key("\r");
  assert.equal((await running).details.answers[0].value, "19");
});
test("questionnaire strips residual terminal controls from model-provided labels", async () => {
  const h = host();
  const running = h.run([{ id: "safe", prompt: "safe\x1bcRESET", options: [{ value: "a", label: "answer\x07\x9b31m" }] }]);
  const rendered = h.render().join("\n");
  assert.ok(!rendered.includes("\x1bc"));
  assert.ok(!rendered.includes("\x07"));
  assert.ok(!rendered.includes("\x9b"));
  h.key("\x1b");
  await running;
});
