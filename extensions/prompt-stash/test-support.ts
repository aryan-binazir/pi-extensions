import assert from "node:assert/strict";
import { CustomEditor, InteractiveMode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editor } from "../vi-mode/test-support.ts";
import { Container } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import stash from "./index.ts";
import viMode from "../vi-mode/index.ts";

type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
export function stashHost(EditorClass = CustomEditor, withViMode = false) {
  const hooks = new Map<string, ((...args: any[]) => unknown)[]>();
  let factory: Factory | undefined = EditorClass === CustomEditor ? undefined : (...args) => new EditorClass(...args);
  const e = editor(EditorClass);
  const app: any = Object.create(InteractiveMode.prototype);
  const sessionManager = {};
  Object.defineProperty(app, "session", { value: { sessionManager } });
  app.editor = e;
  app.defaultEditor = editor(CustomEditor);
  app.editorComponentFactory = factory;
  app.ui = (e as any).tui;
  app.ui.setFocus = () => {};
  app.editorContainer = new Container();
  app.statusContainer = new Container();
  app.keybindings = new KeybindingsManager();
  app.disposeActiveSelector = () => {};
  let status: string | undefined;
  let installs = 0;
  const ctx = {
    mode: "tui", hasUI: true, sessionManager,
    ui: {
      getEditorComponent: () => app.editorComponentFactory,
      setEditorComponent: (f: Factory | undefined) => {
        factory = f; installs++;
        app.setCustomEditorComponent(f);
      },
      getEditorText: () => app.editor.getExpandedText(),
      setEditorText: (text: string) => app.editor.setText(text),
      pasteToEditor: (text: string) => app.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
      setStatus: (_key: string, text: string | undefined) => { status = text; },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, fn: (...args: any[]) => unknown) => {
      const handlers = hooks.get(name) ?? [];
      handlers.push(fn); hooks.set(name, handlers);
    },
    registerShortcut: () => assert.fail("stash must not register a conflicting application shortcut"),
  } as unknown as ExtensionAPI;
  if (withViMode) viMode(pi);
  stash(pi);
  const emit = (name: string) => { for (const fn of hooks.get(name) ?? []) fn({}, ctx); };
  emit("session_start"); emit("resources_discover");
  return { ctx, emit, get editor() { return app.editor as CustomEditor; }, get status() { return status; }, get installs() { return installs; } };
}
