import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import effort from "./index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

function host(t: TestContext, defaults = { model: "test", level: "high" }) {
  let thinkingLevel = defaults.level;
  const commands: Record<string, any> = {};
  const hooks: Record<string, any> = {};
  let component: any;
  const changes: any[] = [];
  const notices: string[] = [];
  const model = {
    id: defaults.model,
    provider: "test",
    reasoning: true,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      xhigh: null,
      max: "max",
    },
  };
  const pi: any = {
    registerCommand: (n: string, c: any) => {
      commands[n] = c;
    },
    on: (n: string, h: any) => {
      hooks[n] = h;
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (v: any) => {
      thinkingLevel = v;
      changes.push(v);
    },
    setModel: async (m: any) => {
      ctx.model = m;
      changes.push(m.id);
      return true;
    },
  };
  const ctx: any = {
    mode: "tui",
    model,
    modelRegistry: { find: () => model },
    sessionManager: { getSessionFile: () => "/synthetic/session" },
    ui: {
      notify: (m: string) => notices.push(m),
      custom: (f: any) =>
        new Promise((resolve) => {
          component = f({ requestRender() {} }, {}, {}, resolve);
        }),
    },
  };
  effort(pi);
  t.after(() => hooks.session_shutdown());
  hooks.session_start?.({}, ctx);
  return {
    commands,
    hooks,
    pi,
    ctx,
    changes,
    notices,
    key: (s: string) => component.handleInput(s),
    render: (width = 80) => component.render(width).join("\n"),
    lines: (width = 80): string[] => component.render(width),
  };
}
test("slider traverses only actual supported thinking levels", async (t) => {
  const h = host(t);
  const result = h.commands.effort.handler("", h.ctx);
  assert.match(h.render(), /off.*high.*max/);
  assert.doesNotMatch(h.render(), /medium/);
  h.key("\u001b[C");
  h.key("\r");
  await result;
  assert.deepEqual(h.changes, ["max"]);
});
test("slider has a padded full border and fits narrow terminals", async (t) => {
  const h = host(t);
  h.ctx.model.id = "模型".repeat(60);
  const result = h.commands.effort.handler("", h.ctx);
  for (const width of [5, 20, 40, 80]) {
    const lines = h.render(width).split("\n");
    assert.equal(lines[0], `╭${"─".repeat(width - 2)}╮`);
    assert.equal(lines.at(-1), `╰${"─".repeat(width - 2)}╯`);
    for (const line of lines) assert.equal(visibleWidth(line), width);
    for (const line of lines.slice(1, -1)) assert.match(line, /^│ .* │$/);
  }
  for (const width of [1, 2, 4])
    for (const line of h.render(width).split("\n"))
      assert.ok(visibleWidth(line) <= width);
  h.key("\u001b");
  await result;
  h.hooks.session_shutdown();
});

test("new-session handoff applies only on replacement runtime and leaves defaults alone", async (t) => {
  const defaults = { model: "saved-model", level: "high" };
  const old = host(t, defaults);
  const unrelated = host(t, defaults);
  unrelated.ctx.sessionManager.getSessionFile = () => "/synthetic/unrelated";
  unrelated.ctx.modelRegistry.find = () => ({ ...unrelated.ctx.model, id: "test" });
  let fresh: ReturnType<typeof host>;
  old.ctx.newSession = async ({ withSession }: any) => {
    old.hooks.session_shutdown();
    fresh = host(t, defaults);
    fresh.ctx.modelRegistry.find = () => ({ ...fresh.ctx.model, id: "test" });
    fresh.ctx.sessionManager.getSessionFile = () => "/synthetic/new";
    await withSession(fresh.ctx);
    return { cancelled: false };
  };
  old.ctx.modelRegistry.find = () => ({ ...old.ctx.model, id: "test" });
  await old.commands.effort.handler("new max test/test", old.ctx);
  assert.deepEqual(old.changes, []);
  assert.equal(unrelated.ctx.model.id, "saved-model");
  assert.equal(unrelated.pi.getThinkingLevel(), "high");
  assert.deepEqual(fresh!.changes, ["test", "max"]);
  // Unrelated new/resumed sessions have no pending global handoff.
  fresh!.hooks.session_shutdown();
  assert.equal(fresh!.ctx.model.id, "test");
  assert.equal(fresh!.pi.getThinkingLevel(), "max");
  const later = host(t, defaults);
  assert.equal(later.ctx.model.id, "saved-model");
  assert.equal(later.pi.getThinkingLevel(), "high");
  assert.deepEqual(later.changes, []);
});
test("cancelled slider and unsupported level do not change thinking", async (t) => {
  const h = host(t);
  const result = h.commands.effort.handler("", h.ctx);
  h.key("\u001b");
  await result;
  await h.commands.effort.handler("medium", h.ctx);
  assert.deepEqual(h.changes, []);
  assert.match(h.notices[0], /Supported levels/);
});
test("cancelled new session has no handoff and shutdown closes slider", async (t) => {
  const h = host(t);
  h.ctx.newSession = async () => ({ cancelled: true });
  await h.commands.effort.handler("new max", h.ctx);
  assert.deepEqual(h.changes, []);
  assert.match(h.notices[0], /cancelled/);
  const result = h.commands.effort.handler("", h.ctx);
  h.hooks.session_shutdown();
  await result;
});

test("a new-session model can be supplied without a thinking level", async (t) => {
  const old = host(t);
  let fresh: ReturnType<typeof host>;
  old.ctx.newSession = async ({ withSession }: any) => {
    old.hooks.session_shutdown();
    fresh = host(t);
    fresh.ctx.sessionManager.getSessionFile = () => "/synthetic/model-only";
    await withSession(fresh.ctx);
    return { cancelled: false };
  };
  const result = old.commands.effort.handler("new test/test", old.ctx);
  assert.match(old.render(), /Effort/);
  old.key("\r");
  await result;
  assert.deepEqual(fresh!.changes, ["test", "high"]);
  fresh!.hooks.session_shutdown();
});

test("slider clamps unsupported current effort to a supported target level", async (t) => {
  const h = host(t, { model: "test", level: "medium" });
  const result = h.commands.effort.handler("", h.ctx);
  assert.match(h.render(), /\[● high\]/);
  h.key("\r");
  await result;
  assert.deepEqual(h.changes, ["high"]);
});

test("a slow new-session model handoff reports success after it applies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = host(t);
  let fresh: ReturnType<typeof host>;
  let finishModel!: () => void;
  old.ctx.newSession = async ({ withSession }: any) => {
    old.hooks.session_shutdown();
    fresh = host(t);
    fresh.ctx.sessionManager.getSessionFile = () => "/synthetic/slow";
    const setModel = fresh.pi.setModel;
    fresh.pi.setModel = async (model: any) => {
      await new Promise<void>((resolve) => {
        finishModel = resolve;
      });
      return setModel(model);
    };
    await withSession(fresh.ctx);
    return { cancelled: false };
  };
  const result = old.commands.effort.handler("new max", old.ctx);
  t.mock.timers.tick(5100);
  await Promise.resolve();
  const pendingNotices = [...fresh!.notices];
  finishModel();
  await result;
  assert.deepEqual(pendingNotices, []);
  assert.deepEqual(fresh!.notices, ["Temporary test/test · max"]);
  assert.deepEqual(fresh!.changes, ["test", "max"]);
});

test("an unacknowledged replacement session times out without applying effort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = host(t);
  const unrelated = host(t, { model: "saved-model", level: "high" });
  unrelated.ctx.sessionManager.getSessionFile = () => "/synthetic/unrelated";
  const notices: string[] = [];
  old.ctx.newSession = async ({ withSession }: any) => {
    old.hooks.session_shutdown();
    await withSession({
      sessionManager: { getSessionFile: () => "/synthetic/missing" },
      ui: { notify: (message: string) => notices.push(message) },
    });
    return { cancelled: false };
  };
  const result = old.commands.effort.handler("new max", old.ctx);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(notices, [
    "Effort extension did not acknowledge the new session",
  ]);
  await result;
  assert.deepEqual(old.changes, []);
  assert.deepEqual(unrelated.changes, []);
  assert.equal(unrelated.ctx.model.id, "saved-model");
  assert.equal(unrelated.pi.getThinkingLevel(), "high");
  const later = host(t);
  later.ctx.sessionManager.getSessionFile = () => "/synthetic/missing";
  await Promise.resolve();
  assert.deepEqual(later.changes, []);
});

test("repeated renders survive width, selection and model changes", async (t) => {
  const h = host(t);
  const result = h.commands.effort.handler("", h.ctx);
  const wide = h.render(80);
  const narrow = h.render(40);
  const tiny = h.render(3);
  assert.equal(h.render(80), wide);
  assert.equal(h.render(40), narrow);
  assert.equal(h.render(3), tiny);
  h.key("[C");
  const moved = h.render(80);
  assert.notEqual(moved, wide);
  h.key("[D");
  assert.equal(h.render(80), wide);
  h.key("[C");
  assert.equal(h.render(80), moved);
  h.ctx.model.id = "renamed-model";
  assert.match(h.render(80), /renamed-model/);
  // Each render hands back its own array; a caller mutating one must not
  // change what the next render returns.
  const first = h.lines(80);
  const second = h.lines(80);
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  first[0] = "tampered";
  assert.deepEqual(h.lines(80), second);
  h.key("");
  await result;
});
