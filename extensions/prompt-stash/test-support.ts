import assert from "node:assert/strict";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editor } from "../vi-mode/test-support.ts";
import stash from "./index.ts";
import viMode from "../vi-mode/index.ts";

type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
export function stashHost(EditorClass = CustomEditor, withViMode = false) {
  const hooks = new Map<string, ((...args: any[]) => unknown)[]>();
  let factory: Factory | undefined = EditorClass === CustomEditor ? undefined : (...args) => new EditorClass(...args);
  let e = editor(EditorClass);
  let status: string | undefined;
  let installs = 0;
  const make = (f: Factory) => editor(class extends CustomEditor {
    constructor(...args: ConstructorParameters<typeof CustomEditor>) {
      super(...args);
      return f(args[0], args[1], args[2]) as CustomEditor;
    }
  });
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent: (f: Factory | undefined) => {
        const text = e.getText();
        factory = f; installs++;
        e = f ? make(f) : editor(CustomEditor);
        e.setText(text);
      },
      getEditorText: () => e.getExpandedText(),
      setEditorText: (text: string) => e.setText(text),
      pasteToEditor: (text: string) => e.handleInput(`\x1b[200~${text}\x1b[201~`),
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
  return { ctx, emit, get editor() { return e; }, get status() { return status; }, get installs() { return installs; } };
}
