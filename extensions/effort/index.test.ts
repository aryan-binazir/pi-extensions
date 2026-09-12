import assert from "node:assert/strict";
import test from "node:test";
import effort from "./index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createEventBus } from "@earendil-works/pi-coding-agent";

function host(bus = createEventBus()) {
  const commands: Record<string, any> = {};
  const hooks: Record<string, any> = {};
  let component: any;
  const changes: any[] = [];
  const notices: string[] = [];
  const model = {
    id: "test",
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
  let active = true;
  const pi: any = {
    events: {
      emit(channel: string, data: unknown) {
        if (!active)
          throw new Error("Pi events are stale after session replacement");
        bus.emit(channel, data);
      },
      on: bus.on.bind(bus),
    },
    registerCommand: (n: string, c: any) => {
      commands[n] = c;
    },
    on: (n: string, h: any) => {
      hooks[n] = (...args: any[]) => {
        const result = h(...args);
        if (n === "session_shutdown") active = false;
        return result;
      };
    },
    getThinkingLevel: () => "high",
    setThinkingLevel: (v: any) => changes.push(v),
    setModel: async (m: any) => {
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
  hooks.session_start?.({}, ctx);
  return {
    commands,
    hooks,
    ctx,
    changes,
    notices,
    key: (s: string) => component.handleInput(s),
    render: (width = 80) => component.render(width).join("\n"),
  };
}
test("slider traverses only actual supported thinking levels", async () => {
  const h = host();
  const result = h.commands.effort.handler("", h.ctx);
  assert.match(h.render(), /off.*high.*max/);
  assert.doesNotMatch(h.render(), /medium/);
  h.key("\u001b[C");
  h.key("\r");
  await result;
  assert.deepEqual(h.changes, ["max"]);
});
test("slider has a padded full border and fits narrow terminals", async () => {
  const h = host();
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

test("new-session handoff applies only on replacement runtime and leaves defaults alone", async () => {
  const bus = createEventBus();
  const old = host(bus);
  let fresh: ReturnType<typeof host>;
  old.ctx.newSession = async ({ withSession }: any) => {
    old.hooks.session_shutdown();
    fresh = host(bus);
    fresh.ctx.sessionManager.getSessionFile = () => "/synthetic/new";
    await withSession(fresh.ctx);
    return { cancelled: false };
  };
  await old.commands.effort.handler("new max test/test", old.ctx);
  assert.deepEqual(old.changes, []);
  assert.deepEqual(fresh!.changes, ["test", "max"]);
  // Unrelated new/resumed sessions have no pending global handoff.
  fresh!.hooks.session_shutdown();
  const later = host(bus);
  assert.deepEqual(later.changes, []);
});
test("cancelled slider and unsupported level do not change thinking", async () => {
  const h = host();
  const result = h.commands.effort.handler("", h.ctx);
  h.key("\u001b");
  await result;
  await h.commands.effort.handler("medium", h.ctx);
  assert.deepEqual(h.changes, []);
  assert.match(h.notices[0], /Supported levels/);
});
test("cancelled new session has no handoff and shutdown closes slider", async () => {
  const h = host();
  h.ctx.newSession = async () => ({ cancelled: true });
  await h.commands.effort.handler("new max", h.ctx);
  assert.deepEqual(h.changes, []);
  assert.match(h.notices[0], /cancelled/);
  const result = h.commands.effort.handler("", h.ctx);
  h.hooks.session_shutdown();
  await result;
});

test("a new-session model can be supplied without a thinking level", async () => {
  const old = host();
  let fresh: ReturnType<typeof host>;
  old.ctx.newSession = async ({ withSession }: any) => {
    old.hooks.session_shutdown();
    fresh = host();
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
