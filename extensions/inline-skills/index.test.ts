import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor, InteractiveMode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Container, stripTerminalSequences, type SlashCommand } from "@earendil-works/pi-tui";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { editor, keys } from "../vi-mode/test-support.ts";
import viMode from "../vi-mode/index.ts";
import stash from "../prompt-stash/index.ts";
import inlineSkills from "./index.ts";

initTheme("dark", false);
const skills: SlashCommand[] = [
  { name: "skill:rocket", description: "Ship a task" },
  { name: "skill:roadmap", description: "Plan the roadmap" },
  { name: "skill:review", description: "Review code" },
  { name: "skill:hypr-backup-timestamped", description: "Back up with a timestamp" },
];
const commands: SlashCommand[] = [{ name: "rollback", description: "Undo a change" }, { name: "model" }];

// Mirrors InteractiveMode's provider stacking, extension UI reset and session binding.
function host({ vi = false, skillCommands = true } = {}) {
  const hooks = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const app: any = Object.create(InteractiveMode.prototype);
  const sessionManager = {};
  Object.defineProperty(app, "session", { value: { sessionManager } });
  app.defaultEditor = editor(CustomEditor);
  app.editor = app.defaultEditor;
  app.ui = app.defaultEditor.tui;
  app.ui.setFocus = () => {};
  app.keybindings = new KeybindingsManager();
  app.editorContainer = new Container();
  app.statusContainer = new Container();
  app.disposeActiveSelector = () => {};
  app.extensionDialogs = [];
  app.autocompleteProviderWrappers = [];
  app.createBaseAutocompleteProvider = () => {
    const base = new CombinedAutocompleteProvider([...commands, ...(skillCommands ? skills : [])], process.cwd());
    const suggest = base.getSuggestions.bind(base);
    // Stands in for fd-backed @ results, which need fd installed.
    base.getSuggestions = async (lines, line, col, options) => lines[line]!.slice(0, col).endsWith(" @")
      ? { items: [{ value: "@notes.md", label: "notes.md" }], prefix: "@" }
      : suggest(lines, line, col, options);
    return base;
  };
  const ctx = {
    mode: "tui", hasUI: true, sessionManager,
    ui: {
      addAutocompleteProvider(factory: unknown) {
        app.autocompleteProviderWrappers.push(factory);
        app.setupAutocompleteProvider();
      },
      getEditorComponent: () => app.editorComponentFactory,
      setEditorComponent: (factory: unknown) => app.setCustomEditorComponent(factory),
      getEditorText: () => app.editor.getExpandedText(),
      setEditorText: (text: string) => app.editor.setText(text),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
      hooks.set(name, [...hooks.get(name) ?? [], fn]);
    },
  } as unknown as ExtensionAPI;
  if (vi) { viMode(pi); stash(pi); }
  inlineSkills(pi);
  const emit = (name: string) => { for (const fn of hooks.get(name) ?? []) fn({ type: name }, ctx); };
  const start = () => {
    app.autocompleteProviderWrappers = [];
    app.setCustomEditorComponent(undefined);
    app.setupAutocompleteProvider();
    emit("session_start"); emit("resources_discover");
  };
  start();
  let submitted: string | undefined;
  app.editor.onSubmit = (text: string) => { submitted = text; };
  return {
    app, emit, start,
    get editor(): CustomEditor { return app.editor; },
    get submitted() { return submitted; },
    async type(input: string) { keys(app.editor, input); await settle(); },
    async press(key: string) { app.editor.handleInput(key); await settle(); },
    menu(): string[] {
      if (!app.editor.isShowingAutocomplete()) return [];
      const lines = stripTerminalSequences(app.editor.render(100).join("\n")).split("\n");
      const menu = lines.slice(lines.map(line => /^─+$/.test(line)).lastIndexOf(true) + 1);
      return menu.map(line => /^(?:→| ) (\S+)/.exec(line)?.[1]).filter((label): label is string => !!label);
    },
  };
}
// Covers Pi's 20 ms @-attachment debounce.
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

for (const vi of [false, true]) {
  const name = vi ? "ViEditor" : "CustomEditor";

  test(`${name}: mid-message slash lists only skills, matched like Pi's own menu`, async () => {
    const h = host({ vi });
    await h.type("please use /ro");
    assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap"]);
    await h.type("c");
    assert.deepEqual(h.menu(), ["skill:rocket"]);
  });

  test(`${name}: Tab inserts the skill command and keeps the rest of the message`, async () => {
    const h = host({ vi });
    await h.type("then /roc and more");
    for (let i = 0; i < " and more".length; i++) await h.press("\x1b[D");
    assert.deepEqual(h.menu(), []);
    await h.press("\x7f");
    await h.type("c");
    assert.deepEqual(h.menu(), ["skill:rocket"]);
    await h.press("\t");
    assert.equal(h.editor.getText(), "then /skill:rocket and more");
    assert.equal(h.editor.getCursor().col, "then /skill:rocket ".length);
    assert.deepEqual(h.menu(), []);
  });

  test(`${name}: Enter accepts the skill without submitting, Escape dismisses`, async () => {
    const h = host({ vi });
    await h.type("try /ro");
    await h.press("\x1b[B");
    await h.press("\r");
    assert.equal(h.editor.getText(), "try /skill:roadmap ");
    assert.equal(h.submitted, undefined);
    await h.type("and /rev");
    assert.deepEqual(h.menu(), ["skill:review"]);
    await h.press("\x1b");
    assert.deepEqual(h.menu(), []);
    assert.equal(h.editor.getText(), "try /skill:roadmap and /rev");
  });

  test(`${name}: slash at the start of a later line lists skills`, async () => {
    const h = host({ vi });
    h.editor.setText("first line\n");
    await h.type("/sk");
    assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap", "skill:review", "skill:hypr-backup-timestamped"]);
  });
}

test("message-start slash keeps Pi's full command menu", async () => {
  const h = host();
  await h.type("/ro");
  assert.deepEqual(h.menu(), ["rollback", "skill:rocket", "skill:roadmap"]);
  await h.press("\t");
  assert.equal(h.editor.getText(), "/rollback ");
});

test("slashes inside words, paths and URLs do not open the menu", async () => {
  const h = host();
  for (const text of ["and/ro", "see //ro", "path /ro/", "x (/ro", "a /ro "]) {
    h.editor.setText("");
    await h.type(text);
    assert.deepEqual(h.menu(), [], text);
  }
  h.editor.setText("");
  await h.type("open /ro");
  assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap"]);
  await h.type("/");
  assert.deepEqual(h.menu(), [], "a second slash makes it a path and closes the menu");
});

test("leaving the token closes the menu instead of listing files", async () => {
  const h = host();
  for (const leave of [" ", "\x1b[D\x1b[D\x1b[D"]) {
    h.editor.setText("");
    await h.type("use /ro");
    assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap"]);
    for (const key of leave.match(/\x1b\[.|./g)!) await h.press(key);
    assert.deepEqual(h.menu(), [], JSON.stringify(leave));
  }
  await h.type(" @");
  assert.deepEqual(h.menu(), ["notes.md"], "Pi's own @ menu still opens right after");
});

test("backspacing over the slash closes the menu instead of listing files", async () => {
  const h = host();
  await h.type("use /");
  assert.ok(h.menu().length > 0);
  await h.press("\x7f");
  assert.deepEqual(h.menu(), []);
});

test("a burst of keys that leaves the token shows no file list, but a following @ still completes", async () => {
  const h = host();
  for (const burst of ["use /ro ", "use /ro  ", "use /ro and more "]) {
    h.editor.setText("");
    keys(h.editor, burst);
    await settle();
    assert.deepEqual(h.menu(), [], JSON.stringify(burst));
  }
  h.editor.setText("");
  keys(h.editor, "use /ro and @");
  await settle();
  assert.deepEqual(h.menu(), ["notes.md"], "Pi's own @ menu");
  h.editor.setText("");
  keys(h.editor, "use /ro ");
  keys(h.editor, "/ro @");
  await settle();
  assert.deepEqual(h.menu(), ["notes.md"], "Pi's own @ menu");
});

test("Kitty-encoded keys open the menu", async () => {
  const h = host();
  await h.type("use ");
  await h.press("\x1b[47u");
  await h.press("\x1b[114u");
  assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap", "skill:review"]);
});

test("pasted text does not open the menu", async () => {
  const h = host();
  await h.press("\x1b[200~use /ro\x1b[201~");
  assert.deepEqual(h.menu(), []);
});

test("vi Escape dismisses the menu and enters normal mode; Prompt Stash still owns Ctrl+S", async () => {
  const h = host({ vi: true });
  await h.type("use /ro");
  await h.press("\x1b");
  assert.deepEqual(h.menu(), []);
  await h.press("x");
  assert.equal(h.editor.getText(), "use /r");
  await h.press("\x13");
  assert.equal(h.editor.getText(), "");
  await h.press("\x13");
  assert.equal(h.editor.getText(), "use /r");
});

test("only skills with a word starting with the token are listed, so paths stay quiet", async () => {
  const h = host();
  await h.type("/tm");
  assert.ok(h.menu().includes("skill:hypr-backup-timestamped"), "Pi's message-start menu matches fuzzily");
  for (const [token, expected] of [["tm", []], ["time", ["skill:hypr-backup-timestamped"]], ["skill:hypr", ["skill:hypr-backup-timestamped"]], ["backup-t", ["skill:hypr-backup-timestamped"]], ["RO", ["skill:rocket", "skill:roadmap"]]] as const) {
    h.editor.setText("");
    await h.type(`see /${token}`);
    assert.deepEqual(h.menu(), expected, token);
  }
});

test("a stale menu after jumping to the line start leaves the text alone", async () => {
  const h = host();
  await h.type("please use /ro");
  await h.press("\x01");
  await h.press("\t");
  assert.equal(h.editor.getText(), "please use /ro");
});

test("Tab after a mid-message slash still completes paths", async () => {
  const h = host();
  await h.type("look in /tm");
  assert.deepEqual(h.menu(), []);
  await h.press("\t");
  assert.equal(h.editor.getText(), "look in /tmp/");
});

test("backspace reopens the menu once the token matches again", async () => {
  const h = host();
  await h.type("use /rox");
  assert.deepEqual(h.menu(), []);
  await h.press("\x7f");
  assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap"]);
});

test("vi normal-mode commands do not open the menu", async () => {
  const h = host({ vi: true });
  await h.type("use /rocxx");
  await h.press("\x1b");
  for (const key of ["h", "l", "x", "X", "\x7f", "0", "$"]) {
    await h.press(key);
    assert.deepEqual(h.menu(), [], key);
  }
  await h.type("a");
  await h.press("\x7f");
  assert.deepEqual(h.menu(), ["skill:rocket", "skill:roadmap"], "insert-mode backspace does");
});

test("vi normal-mode Ctrl+W does not open the menu", async () => {
  const h = host({ vi: true });
  await h.type("use /rocxxx");
  await h.press("\x1b");
  await h.press("\x17");
  assert.deepEqual(h.menu(), []);
});

test("no skills listed when Pi's skill commands are disabled", async () => {
  const h = host({ skillCommands: false });
  await h.type("use /ro");
  assert.deepEqual(h.menu(), []);
});

test("re-registering across sessions neither stacks nor goes stale", async () => {
  const h = host();
  h.emit("session_shutdown");
  h.start();
  h.start();
  assert.equal(h.app.autocompleteProviderWrappers.length, 1);
  await h.type("use /roc");
  assert.deepEqual(h.menu(), ["skill:rocket"]);
  h.emit("session_shutdown");
  h.editor.setText("");
  await h.type("use /roc");
  assert.deepEqual(h.menu(), [], "shutdown removes the trigger");
});
