// Lead-owned acceptance regression from Ar's original Vi-mode screenshot:
// "Treats collapsed paste payloads atomically so editing their visible markers
// does not corrupt the underlying pasted text." See the review contract's
// "Lead resolution of Codex R1 collapsed-paste uncertainty" section.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editor } from "../extensions/vi-mode/test-support.ts";

test("reference acceptance: large pasted payload stays collapsed and survives atomic marker edit/undo", () => {
  const e = editor();
  const payload = "Synthetic pasted line for collapsed-marker verification.\n".repeat(100);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  assert.equal(e.getExpandedText(), payload);
  assert.match(
    e.getText(),
    /\[paste #\d+/,
    "Ar's reference requires Pi's visible collapsed paste marker; expanded-only handling is insufficient",
  );
  assert.ok(e.getText().length < 100, "The editable draft should contain the marker, not all 100 lines");

  e.handleInput("\x1b");
  e.handleInput("0");
  e.handleInput("x");
  assert.equal(e.getExpandedText(), "", "Deleting the visible marker must remove the entire payload atomically");
  e.handleInput("u");
  assert.equal(e.getExpandedText(), payload, "Undo must restore the original payload, not merely its marker text");
  assert.match(e.getText(), /\[paste #\d+/);
});

test("collapsed payload survives the actual stash shortcut and editor replacement", async () => {
  const { default: stash } = await import("../extensions/prompt-stash/index.ts");
  type API = import("@earendil-works/pi-coding-agent").ExtensionAPI;
  type Context = import("@earendil-works/pi-coding-agent").ExtensionContext;
  let handler!: (ctx: Context) => unknown;
  stash({
    on() {},
    registerShortcut(key: string, options: { handler: typeof handler }) {
      assert.equal(key, "ctrl+s");
      handler = options.handler;
    },
  } as unknown as API);
  let e = editor();
  const ctx = {
    hasUI: true,
    ui: {
      getEditorText: () => e.getExpandedText(),
      setEditorText: (text: string) => e.setText(text),
      setStatus() {},
    },
  } as unknown as Context;
  const payload = "\tSynthetic\r\n😀\n".repeat(100);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  await handler(ctx);
  assert.equal(e.getExpandedText(), "");
  e = editor();
  await handler(ctx);
  assert.equal(e.getExpandedText(), payload);
  assert.match(e.getText(), /^\[paste #/);
  e.handleInput("\x1b");
  e.handleInput("0");
  e.handleInput("x");
  assert.equal(e.getExpandedText(), "");
  e.handleInput("u");
  assert.equal(e.getExpandedText(), payload);
});
