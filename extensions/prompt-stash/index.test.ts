import {
  matchesKey,
  setKittyProtocolActive,
  type KeyId,
} from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import stash from "./index.ts";
import { editor } from "../vi-mode/test-support.ts";
test("stash retains expanded pasted text, swaps drafts, and clears on session reload", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let shortcut:
    | {
        handler: (ctx: ExtensionContext) => unknown;
      }
    | undefined;
  let status: string | undefined;
  const e = editor();
  const ctx = {
    hasUI: true,
    ui: {
      getEditorText: () => e.getExpandedText(),
      setEditorText: (s: string) => e.setText(s),
      pasteToEditor: (s: string) => e.handleInput(`\x1b[200~${s}\x1b[201~`),
      setStatus: (_key: string, s: string | undefined) => {
        status = s;
      },
    },
  } as unknown as ExtensionContext;
  stash({
    on: (name: string, h: (...args: unknown[]) => unknown) =>
      handlers.set(name, h),
    registerShortcut: (_key: string, s: typeof shortcut) => {
      shortcut = s;
    },
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({}, ctx);
  const payload = "long pasted payload\n".repeat(1000);
  e.handleInput("\x1b[200~" + payload + "\x1b[201~");
  await shortcut!.handler(ctx);
  assert.equal(e.getExpandedText(), "");
  assert.match(status!, /stash/i);
  e.setText("second draft");
  await shortcut!.handler(ctx);
  assert.equal(e.getExpandedText(), payload);
  await shortcut!.handler(ctx);
  assert.equal(e.getExpandedText(), "second draft");
  await handlers.get("session_start")?.({ reason: "reload" }, ctx);
  e.setText("");
  await shortcut!.handler(ctx);
  assert.equal(e.getExpandedText(), "");
  assert.equal(status, undefined);
});
test("independent stash restores default editor collapsed paste markers", async () => {
  let handler!: (ctx: ExtensionContext) => unknown;
  stash({
    on() {},
    registerShortcut: (
      _key: string,
      s: {
        handler: typeof handler;
      },
    ) => {
      handler = s.handler;
    },
  } as unknown as ExtensionAPI);
  const e = editor(CustomEditor);
  const payload = "payload line\n".repeat(1000);
  e.handleInput("\x1b[200~" + payload + "\x1b[201~");
  assert.notEqual(e.getText(), payload);
  assert.equal(e.getExpandedText(), payload);
  const ctx = {
    hasUI: true,
    ui: {
      getEditorText: () => e.getExpandedText(),
      setEditorText: (s: string) => e.setText(s),
      pasteToEditor: (s: string) => e.handleInput(`\x1b[200~${s}\x1b[201~`),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  await handler(ctx);
  assert.equal(e.getExpandedText(), "");
  await handler(ctx);
  assert.match(e.getText(), /^\[paste #\d+/);
  assert.ok(e.getText().length < 100);
  assert.equal(e.getExpandedText(), payload);
});

test("the registered shifted shortcut leaves legacy Ctrl+S untouched and stashes raw pasted bytes", async () => {
  let chord: KeyId = "ctrl+shift+s";
  let handler!: (ctx: ExtensionContext) => unknown;
  stash({
    on() {},
    registerShortcut: (key: KeyId, definition: { handler: typeof handler }) => {
      chord = key;
      handler = definition.handler;
    },
  } as unknown as ExtensionAPI);
  const e = editor();
  const payload = "\t😀\r\nraw\rpayload";
  e.handleInput("\x1b[200~" + payload + "\x1b[201~");
  const ctx = {
    hasUI: true,
    ui: {
      getEditorText: () => e.getExpandedText(),
      setEditorText: (text: string) => e.setText(text),
      pasteToEditor: (text: string) => e.handleInput(`\x1b[200~${text}\x1b[201~`),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  try {
    for (const kitty of [false, true]) {
      setKittyProtocolActive(kitty);
      assert.equal(
        matchesKey("\x13", chord),
        false,
        "legacy Ctrl+S is never the stash shortcut",
      );
      assert.equal(e.getExpandedText(), payload);
    }
    setKittyProtocolActive(true);
    assert.equal(matchesKey("\x1b[115;6u", chord), true);
    await handler(ctx);
    assert.equal(e.getExpandedText(), "");
    await handler(ctx);
    assert.equal(e.getExpandedText(), payload);
  } finally {
    setKittyProtocolActive(false);
  }
});

test("stash preserves literal paste terminators and their suffix", async () => {
  let handler!: (ctx: ExtensionContext) => unknown;
  stash({
    on() {},
    registerShortcut: (_key: string, s: { handler: typeof handler }) => {
      handler = s.handler;
    },
  } as unknown as ExtensionAPI);
  const e = editor(CustomEditor);
  const payload = "draft\x1b[201~suffix";
  e.setText(payload);
  assert.equal(e.getExpandedText(), payload);
  const ctx = {
    hasUI: true,
    ui: {
      getEditorText: () => e.getExpandedText(),
      setEditorText: (text: string) => e.setText(text),
      pasteToEditor: (text: string) => e.handleInput(`\x1b[200~${text}\x1b[201~`),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  await handler(ctx);
  assert.equal(e.getExpandedText(), "");
  await handler(ctx);
  assert.equal(e.getExpandedText(), payload);
});
