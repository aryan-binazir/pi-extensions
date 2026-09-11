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

function host() {
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
    events: { emit: (_: string, value: any) => events.push(value) },
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
