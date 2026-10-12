import assert from "node:assert/strict";
import { test } from "node:test";
import { PasteFramer, type PasteFrame } from "./paste-framing.ts";

const start = "\x1b[200~", end = "\x1b[201~";
const key = (data: string): PasteFrame => ({ type: "key", data });
const paste = (data: string): PasteFrame => ({ type: "paste", data });
type Case = { name: string; chunks: string[]; frames: PasteFrame[][]; states?: [boolean, boolean][] };
const cases: Case[] = [
  { name: "whole paste", chunks: [start + "payload" + end], frames: [[paste("payload")]] },
  { name: "empty input", chunks: [""], frames: [[key("")]] },
  { name: "empty paste", chunks: [start + end], frames: [[paste("")]] },
  { name: "text around paste", chunks: ["before" + start + "payload" + end + "after"],
    frames: [[key("before"), paste("payload"), key("after")]] },
  { name: "lone escape", chunks: ["\x1b", "x"], frames: [[key("\x1b")], [key("x")]] },
  { name: "legacy Alt+[", chunks: ["\x1b[", "x"], frames: [[key("\x1b[")], [key("x")]] },
  { name: "stalled opener completed byte by byte", chunks: ["\x1b[2", "0", "0", "~", "payload", end],
    frames: [[], [], [], [], [], [paste("payload")]],
    states: [[false, true], [false, true], [false, true], [true, false], [true, false], [false, false]] },
  { name: "stalled opener followed by unrelated key", chunks: ["\x1b[2", "x"],
    frames: [[], [key("\x1b[2x")]], states: [[false, true], [false, false]] },
  { name: "stalled Insert key", chunks: ["\x1b[2", "~"], frames: [[], [key("\x1b[2~")]], states: [[false, true], [false, false]] },
  { name: "stalled F9 key", chunks: ["\x1b[20", "~"], frames: [[], [key("\x1b[20~")]], states: [[false, true], [false, false]] },
  { name: "abandoned opener before fresh paste", chunks: ["\x1b[2", start + "payload" + end],
    frames: [[], [paste("payload")]], states: [[false, true], [false, false]] },
  { name: "abandoned fragments after ordinary text", chunks: ["before\x1b[2\x1b[20" + start + "payload" + end],
    frames: [[key("before"), paste("payload")]] },
  { name: "unrelated continuation and new partial opener", chunks: ["\x1b[2", "x\x1b[20", "0~payload" + end],
    frames: [[], [key("\x1b[2x")], [paste("payload")]], states: [[false, true], [false, true], [false, false]] },
  { name: "nested opener is payload", chunks: [start + "one" + start + "two" + end],
    frames: [[paste("one" + start + "two")]] },
  { name: "first closer terminates even a literal closer", chunks: [start + "one" + end + "two" + end],
    frames: [[paste("one"), key("two" + end)]] },
  { name: "closer outside paste is key data", chunks: ["\x1b[201", "\x13"],
    frames: [[key("\x1b[201")], [key("\x13")]] },
  { name: "back-to-back pastes", chunks: [start + "one" + end + start + "two" + end],
    frames: [[paste("one"), paste("two")]] },
  { name: "text before stalled opener", chunks: ["prefix\x1b[2", "00~payload\x1b", "[201~suffix"],
    frames: [[key("prefix")], [], [paste("payload"), key("suffix")]],
    states: [[false, true], [true, true], [false, false]] },
  { name: "closer completed byte by byte", chunks: [start + "payload", "\x1b", "[", "2", "0", "1", "~"],
    frames: [[], [], [], [], [], [], [paste("payload")]],
    states: [[true, false], [true, true], [true, true], [true, true], [true, true], [true, true], [false, false]] },
];
for (let offset = 0; offset <= start.length; offset++) {
  const legacy = offset === 1 || offset === 2;
  cases.push({ name: `opener split at ${offset}`, chunks: [start.slice(0, offset), start.slice(offset) + "payload" + end],
    frames: [offset === 0 ? [key("")] : legacy ? [key(start.slice(0, offset))] : [],
      legacy ? [key(start.slice(offset) + "payload" + end)] : [paste("payload")]],
    states: [[offset === 6, offset >= 3 && offset < 6], [false, false]] });
}
for (let offset = 0; offset <= end.length; offset++) {
  cases.push({ name: `closer split at ${offset}`, chunks: [start + "payload" + end.slice(0, offset), end.slice(offset)],
    frames: [offset === 6 ? [paste("payload")] : [], offset === 6 ? [key("")] : [paste("payload")]],
    states: [[offset < 6, offset > 0 && offset < 6], [false, false]] });
}

test("bracketed paste framing preserves ordered raw frames across chunk boundaries", async t => {
  for (const c of cases) await t.test(c.name, () => {
    const framer = new PasteFramer();
    for (let i = 0; i < c.chunks.length; i++) {
      assert.deepEqual([...framer.feed(c.chunks[i])], c.frames[i], `chunk ${i}`);
      assert.deepEqual([framer.pasting, framer.holdingMarker], c.states?.[i] ?? [false, false], `state after chunk ${i}`);
    }
  });
});

test("reset discards both an unfinished paste and a stalled opener", () => {
  for (const partial of ["\x1b[20", start + "unfinished\x1b["]) {
    const framer = new PasteFramer();
    assert.deepEqual([...framer.feed(partial)], []);
    framer.reset();
    assert.deepEqual([...framer.feed("0~next" + end)], [key("0~next" + end)]);
    assert.deepEqual([framer.pasting, framer.holdingMarker], [false, false]);
  }
});
