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
  const e = editor(EditorClass);
  const app: any = Object.create(InteractiveMode.prototype);
  const sessionManager = {};
  Object.defineProperty(app, "session", { value: { sessionManager } });
  app.editor = e;
  app.defaultEditor = editor(CustomEditor);
  if (EditorClass !== CustomEditor) app.editorComponentFactory = ((...args) => new EditorClass(...args)) satisfies Factory;
  app.ui = (e as any).tui;
  app.ui.setFocus = () => {};
  app.editorContainer = new Container();
  app.statusContainer = new Container();
  app.keybindings = new KeybindingsManager();
  app.disposeActiveSelector = () => {};
  let status: string | undefined;
  app.footerDataProvider = { setExtensionStatus: (_key: string, text: string | undefined) => { status = text; } };
  let installs = 0;
  app.setCustomEditorComponent = function (this: unknown, factory: Factory | undefined) {
    installs++;
    return (InteractiveMode.prototype as any).setCustomEditorComponent.call(this, factory);
  };
  const ctx = { mode: "tui", hasUI: true, sessionManager, ui: app.createExtensionUIContext() } as unknown as ExtensionContext;
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
