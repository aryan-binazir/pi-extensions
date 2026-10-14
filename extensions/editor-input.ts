import { InteractiveMode, type CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Editor } from "@earendil-works/pi-tui";
import { PasteFramer, type PasteFrame } from "./paste-framing.ts";
import { expandPastes, placeCursor, readPastes, restoreRawDraft, writePastes } from "./vi-mode/adapter.ts";

type Host = {
  editor: Editor;
  session?: { sessionManager: object };
  ui?: { getFocusedComponent?(): Component | null };
};
type Replace = (this: Host, factory: unknown) => void;
type Show = (this: Host, factory: unknown, options?: { overlay?: boolean }) => Promise<unknown>;
type Binding = { key(data: string): boolean; beforePaste?(): void; reset?(): void };
export type EditorBinding = {
  id: string;
  priority: number;
  create(editor: CustomEditor, forward: (data: string) => void, ready: () => boolean): Binding;
};
type Backend = { key(data: string): void; paste(data: string): void; release(): void; acquire(): void };
type Input = {
  editor: Editor;
  original: Editor["handleInput"];
  framer: PasteFramer;
  host?: Host;
  backend?: Backend;
  bindings: Map<EditorBinding, Binding>;
  forwarding: number;
  depth: number;
  retired: boolean;
  discardPaste: boolean;
};
type State = {
  hosts: WeakMap<object, Host>;
  registrations: WeakMap<object, Map<string, EditorBinding>>;
  dispatch(input: Input, data: string): void;
  replace: (this: Host, original: Replace, factory: unknown) => void;
  show: (this: Host, original: Show, factory: unknown, options?: { overlay?: boolean }) => Promise<unknown>;
};
const handoffInstalled = Symbol.for("pi-interactive:editor-handoff");
const inputInstalled = Symbol.for("pi-interactive:editor-input-owner");
const editorInput = Symbol.for("pi-interactive:editor-input");
const viEditor = Symbol.for("pi-interactive:vi-editor");
type Prototype = {
  [handoffInstalled]?: State | true;
  [inputInstalled]?: State;
  setCustomEditorComponent: Replace;
  showExtensionCustom: Show;
  bindCurrentSessionExtensions(this: Host): Promise<void>;
};
type WiredEditor = Editor & { [editorInput]?: Input };

function current(input: Input): boolean { return !input.host || (!input.retired && input.host.editor === input.editor); }
function focused(input: Input): Component | null | undefined { return input.host?.ui?.getFocusedComponent?.(); }
function forward(input: Input, data: string): void {
  if (!current(input) || (focused(input) != null && focused(input) !== input.editor)) return;
  input.forwarding++;
  try { (input.backend?.key ?? input.original.bind(input.editor))(data); }
  finally { input.forwarding--; }
}
function bindings(input: Input, state: State): Binding[] {
  const manager = input.host?.session?.sessionManager;
  const registrations = manager ? state.registrations.get(manager) : undefined;
  for (const [spec, binding] of input.bindings) if (registrations?.get(spec.id) !== spec) {
    binding.reset?.(); input.bindings.delete(spec);
  }
  return [...registrations?.values() ?? []].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).map(spec => {
    let binding = input.bindings.get(spec);
    if (!binding) {
      binding = spec.create(input.editor as CustomEditor, data => forward(input, data), () => current(input) && (focused(input) == null || focused(input) === input.editor));
      input.bindings.set(spec, binding);
    }
    return binding;
  });
}
function deliver(input: Input, frame: PasteFrame, state: State, nested: boolean): void {
  if (!current(input)) return;
  const target = focused(input);
  if (target != null && target !== input.editor) {
    target.handleInput?.(frame.type === "paste" ? `\x1b[200~${frame.data}\x1b[201~` : frame.data);
    return;
  }
  const handlers = nested ? [] : bindings(input, state);
  if (frame.type === "key") {
    for (const binding of handlers) {
      if (binding.key(frame.data)) return;
      if (!current(input) || (focused(input) != null && focused(input) !== input.editor)) {
        deliver(input, frame, state, true); return;
      }
    }
    forward(input, frame.data);
  } else {
    for (const binding of handlers) binding.beforePaste?.();
    if (input.discardPaste) { input.discardPaste = false; return; }
    if (!current(input) || (focused(input) != null && focused(input) !== input.editor)) {
      deliver(input, frame, state, true); return;
    }
    if (input.backend) input.backend.paste(frame.data);
    else forward(input, `\x1b[200~${frame.data}\x1b[201~`);
  }
}
function dispatch(input: Input, data: string): void {
  if (input.forwarding) {
    (input.backend?.key ?? input.original.bind(input.editor))(data);
    return;
  }
  const state = sharedState();
  const nested = input.depth++ > 0;
  const held = input.framer.pasting || input.framer.holdingMarker;
  try {
    for (const frame of input.framer.feed(data)) deliver(input, frame, state, nested);
    if (!nested && !held && (input.framer.pasting || input.framer.holdingMarker))
      for (const binding of bindings(input, state)) binding.beforePaste?.();
  }
  finally { input.depth--; }
}
export function attachEditorInput(editor: Editor, backend?: Backend): void {
  const state = sharedState();
  let input = (editor as WiredEditor)[editorInput];
  if (!input) {
    const legacy = (editor.handleInput as Editor["handleInput"] & {
      [key: symbol]: { original: Editor["handleInput"]; reset(): void } | undefined;
    })[Symbol.for("pi-interactive:escape-continue-input")];
    legacy?.reset();
    input = { editor, original: legacy?.original ?? editor.handleInput, framer: new PasteFramer(), bindings: new Map(), forwarding: 0, depth: 0, retired: false, discardPaste: false };
    const shared = input;
    Object.defineProperty(editor, editorInput, { value: shared });
    editor.handleInput = data => state.dispatch(shared, data);
  }
  input.backend ??= backend;
  if (input.retired) input.backend?.acquire();
  input.retired = false;
}
export function resetEditorInput(editor: Editor): void {
  const input = (editor as WiredEditor)[editorInput];
  if (!input) return;
  if (input.framer.pasting) input.discardPaste = true;
  else input.framer.reset();
}
export function retireEditorInput(editor: Editor): void {
  const input = (editor as WiredEditor)[editorInput];
  if (!input || input.retired) return;
  input.retired = true;
  input.framer.reset();
  input.discardPaste = false;
  for (const binding of input.bindings.values()) binding.reset?.();
  input.bindings.clear();
  input.backend?.release();
}
function attachHost(host: Host, state: State): void {
  const manager = host.session?.sessionManager;
  if (manager) state.hosts.set(manager, host);
  attachEditorInput(host.editor);
  const input = (host.editor as WiredEditor)[editorInput]!;
  input.host = host;
  bindings(input, state);
}
export function registerMainEditorBinding(ctx: ExtensionContext, spec: EditorBinding): () => void {
  const state = sharedState();
  let registrations = state.registrations.get(ctx.sessionManager);
  if (!registrations) state.registrations.set(ctx.sessionManager, registrations = new Map());
  registrations.set(spec.id, spec);
  const refresh = () => {
    const host = state.hosts.get(ctx.sessionManager);
    if (host) attachHost(host, state);
  };
  refresh();
  return () => { if (registrations.get(spec.id) === spec) { registrations.delete(spec.id); refresh(); } };
}
function replace(this: Host, original: Replace, factory: unknown): void {
  const source = this.editor;
  const registry = (source as unknown as { pastes?: unknown }).pastes instanceof Map;
  const text = source.getText();
  const payloads = registry ? readPastes(source) : undefined;
  retireEditorInput(source);
  try { original.call(this, factory); }
  finally { attachHost(this, sharedState()); }
  if (!payloads || (!(viEditor in source) && !(viEditor in this.editor) && payloads.pastes.size === 0)) return;
  if (!((this.editor as unknown as { pastes?: unknown }).pastes instanceof Map)) {
    this.editor.setText(expandPastes(source, text)); return;
  }
  if (viEditor in this.editor) restoreRawDraft(this.editor, text, payloads);
  else {
    this.editor.setText(text);
    writePastes(this.editor, payloads);
    placeCursor(this.editor, this.editor.getText().length);
  }
}
// Inline custom UI also restores getText() via setText(), clearing paste data.
const show: State["show"] = async function (showCustom, factory, options) {
  const source = this.editor;
  if (options?.overlay || !(viEditor in source))
    return showCustom.call(this, factory, options);
  const text = source.getText();
  const payloads = readPastes(source);
  const expanded = expandPastes(source, text);
  const getText = source.getText;
  const captureExpandedDraft = () => {
    source.getText = getText;
    return expanded;
  };
  source.getText = captureExpandedDraft;
  try {
    return await showCustom.call(this, factory, options);
  } finally {
    if (source.getText === captureExpandedDraft) source.getText = getText;
    if (this.editor === source && source.getExpandedText() === expanded) {
      if (source.getText() === text) {
        writePastes(source, payloads);
        source.onChange?.(text);
      } else {
        restoreRawDraft(source, text, payloads);
      }
    }
  }
};

function sharedState(): State {
  return (InteractiveMode.prototype as unknown as Prototype)[inputInstalled] ?? installEditorInput();
}
export function installEditorInput(): State {
  const prototype = InteractiveMode.prototype as unknown as Prototype;
  let state = prototype[inputInstalled];
  if (!state) {
    const previous = prototype[handoffInstalled];
    state = previous && previous !== true ? previous : { hosts: new WeakMap(), registrations: new WeakMap(), dispatch, replace, show };
    state.hosts ??= new WeakMap();
    state.registrations ??= new WeakMap();
    const shared = state;
    Object.defineProperty(prototype, inputInstalled, { value: shared });
    if (!previous) {
      const original = prototype.setCustomEditorComponent;
      const showCustom = prototype.showExtensionCustom;
      prototype.setCustomEditorComponent = function (factory) { return shared.replace.call(this, original, factory); };
      prototype.showExtensionCustom = function (factory, options) { return shared.show.call(this, showCustom, factory, options); };
      Object.defineProperty(prototype, handoffInstalled, { value: shared });
    }
    const bind = prototype.bindCurrentSessionExtensions;
    prototype.bindCurrentSessionExtensions = async function () {
      attachHost(this, shared);
      await bind.call(this);
      attachHost(this, shared);
    };
  }
  state.dispatch = dispatch;
  state.replace = replace;
  state.show = show;
  return state;
}
