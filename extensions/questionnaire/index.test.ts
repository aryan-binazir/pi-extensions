import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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
    events: { on: () => () => {}, emit: (...args: any[]) => events.push(args) },
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
  let uiOptions: any;
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
      on: () => () => {},
      emit: (_: string, value: any) => {
        events.push(value);
        onEmit?.(value);
      },
    },
  } as any);
  const terminal = { rows: 24, columns: 80 };
  const ctx: any = {
    mode: "tui",
    ui: {
      custom: (factory: any, options: any) =>
        new Promise((resolve) => {
          uiOptions = options;
          component = factory(
            { requestRender() {}, terminal },
            { fg: (_: string, s: string) => s },
            {},
            resolve,
          );
        }),
    },
  };
  return {
    terminal,
    events,
    hooks,
    ctx,
    run: (questions: any[], signal?: AbortSignal) =>
      tool.execute("id", { questions }, signal, undefined, ctx),
    key: (key: string) => component.handleInput(key),
    render: (width = 60) => component.render(width),
    options: () => uiOptions,
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
    assert.ok(rows.join("\n").includes(`❯ ${i + 1}. Option-${i}`));
    h.key("\x1b[B");
  }
  h.key("\r");
  assert.equal((await running).details.answers[0].value, "19");
});
test("questionnaire replaces the input area with subtle rules across widths and input modes", async () => {
  const h = host();
  const running = h.run([question("a"), question("b")]);
  assert.deepEqual(h.options(), { overlay: false });
  const checkFrame = () => {
    for (const width of [1, 5, 6, 20, 80, 120]) {
      const rows = h.render(width);
      assert.ok(rows.length <= 24);
      assert.ok(rows.every((row: string) => visibleWidth(row) <= width));
      if (width >= 6) {
        assert.equal(rows[0], "─".repeat(width));
        assert.equal(rows.at(-1), "─".repeat(width));
        assert.ok(rows.every((row: string) => !/[│╭╯]/.test(row)));
      }
    }
  };
  checkFrame();
  h.key("\x1b[B");
  h.key("\r");
  h.key("Custom 日本語 answer");
  checkFrame();
  h.key("\r");
  h.key("\r");
  checkFrame();
  h.key("\r");
  assert.equal((await running).details.cancelled, false);
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

test("long tabs keep every active question and Submit visible", async () => {
  const h = host();
  const running = h.run(Array.from({ length: 6 }, (_, i) => ({
    ...question(`q${i}`), label: `Question-${i} ${"label".repeat(9)}`,
  })));
  try {
    for (let i = 0; i < 6; i++) {
      for (const width of [40, 80]) {
        const rows = h.render(width);
        assert.match(rows.join("\n"), new RegExp(`\\[ .*Question-${i}.*\\]`));
        assert.match(rows.join("\n"), /Submit/);
        assert.ok(rows.every((row: string) => visibleWidth(row) <= width));
      }
      h.key("\t");
    }
    assert.match(h.render(40).join("\n"), /\[ Submit \]/);
  } finally {
    h.key("\x1b");
    await running;
  }
});


test("six-row terminals retain prompt, selection, editor and cancellation controls", async () => {
  const h = host();
  h.terminal.rows = 6;
  const running = h.run([question("small"), question("next")]);
  try {
    const check = (expected: RegExp) => {
      const rows = h.render(80);
      assert.ok(rows.length <= 3);
      assert.match(rows.join("\n"), /Choose small/);
      assert.match(stripTerminalSequences(rows.join("\n")), expected);
    };
    const initial = h.render(80).join("\n");
    assert.match(initial, /1\/3.*Submit.*Choose small/);
    assert.match(initial, /Esc cancel/);
    assert.match(initial, /❯ 1. Yes/);
    h.key("\x1b[B");
    h.key("\r");
    h.key("Draft answer");
    check(/Draft answer/);
    check(/Ctrl\+C cancel/);
    h.key("\x1b[200~\nsecond\nthird\nfourth\nfifth\nsixth\x1b[201~");
    check(/sixth/);
    for (let i = 0; i < 5; i++) h.key("\x1b[A");
    check(/Draft answer/);
    assert.ok(h.render(80).some((line: string) => line.includes("\x1b[7m")), "The editor cursor must remain visible");
    h.key("\x1b");
    h.key("\x1b[A");
    h.key("\r");
    h.key("\r");
    const review = h.render(80);
    assert.ok(review.length <= 3);
    assert.match(review.join("\n"), /Submit.*Review your answers/);
    assert.match(review.join("\n"), /Enter to submit all answers/);
    assert.match(review.join("\n"), /Esc cancel/);
  } finally {
    h.key("\x03");
    await running;
  }
});

test("long prompts use spare terminal rows and disclose remaining text", async () => {
  const h = host();
  const running = h.run([{ ...question("long"),
    prompt: Array.from({ length: 30 }, (_, i) => `Prompt line ${i + 1}`).join("\n"),
  }]);
  try {
    const rows = h.render(80);
    assert.match(rows.join("\n"), /Prompt line 4/);
    assert.match(rows.join("\n"), /prompt truncated/);
    assert.match(rows.join("\n"), /❯ 1. Yes/);
    assert.match(rows.join("\n"), /Esc cancel/);
    assert.ok(rows.length <= 24);
    h.terminal.rows = 48;
    const expanded = h.render(80).join("\n");
    assert.match(expanded, /Prompt line 4/);
    assert.match(expanded, /prompt truncated/);
    h.terminal.rows = 6;
    const compact = h.render(80);
    assert.ok(compact.length <= 3);
    assert.match(compact.join("\n"), /Prompt line 1/);
    assert.match(compact.join("\n"), /prompt truncated/);
    assert.match(compact.join("\n"), /Esc cancel/);
    const narrow = stripTerminalSequences(h.render(20).join("\n"));
    assert.match(narrow, /Prompt line 1.*…/);
    assert.match(narrow, /Esc cancel/);
  } finally {
    h.key("\x1b");
    await running;
  }
});


test("decoration never reduces visible choices as the terminal grows", async () => {
  const h = host();
  const running = h.run([{ ...question("balance"), allowOther: false,
    options: Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `Option-${i}` })),
  }]);
  try {
    let previous = 0;
    for (let height = 6; height <= 30; height++) {
      h.terminal.rows = height;
      const rows = h.render(80);
      const count = rows.filter((line: string) => line.includes("Option-")).length;
      assert.ok(count >= previous, `Growing to ${height} rows hid choices`);
      previous = count;
      assert.ok(rows.length <= Math.max(3, Math.min(18, height - 5)));
      assert.match(rows.join("\n"), /Esc cancel/);
    }
  } finally {
    h.key("\x1b");
    await running;
  }
});

test("long prompts share space with choices within the fullscreen height cap", async () => {
  const h = host();
  h.terminal.rows = 40;
  const running = h.run([{ ...question("balance"), prompt: "Prompt text ".repeat(330), allowOther: false,
    options: Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `Option-${i}` })),
  }]);
  try {
    const rows = h.render(80);
    assert.ok(rows.length <= 18);
    assert.match(rows.join("\n"), /Option-5/);
    assert.match(rows.join("\n"), /prompt truncated/);
    assert.match(rows.join("\n"), /Esc cancel/);
  } finally {
    h.key("\x1b");
    await running;
  }
});
