import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { installEditorInput, registerMainEditorBinding } from "../editor-input.ts";
import { installSinglePassPasteExpansion, readPastes, restoreRawDraft } from "../vi-mode/adapter.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const ESC = 0x1b;
const CTRL_S_BYTE = "s".charCodeAt(0) & 0x1f;
/** CSI u and modifyOtherKeys both spell the key out as a decimal codepoint. */
const CTRL_S_CODEPOINT = String("s".charCodeAt(0));
/** Bytes bracketed paste strips, so text holding them has to be set directly. */
const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

export default function promptStash(pi: ExtensionAPI): void {
  let slot: { text: string; restore?: () => boolean } | undefined;
  let installed: EditorFactory | undefined;
  let previous: EditorFactory | undefined;
  let enabled = false;
  let active: CustomEditor | undefined;
  let unregister: (() => void) | undefined;
  installEditorInput();

  const setText = (ctx: ExtensionContext, text: string) => {
    if (text && ctx.ui.pasteToEditor && !CONTROL_BYTES.test(text)) {
      ctx.ui.setEditorText("");
      ctx.ui.pasteToEditor(text);
    } else ctx.ui.setEditorText(text);
  };

  const toggle = (ctx: ExtensionContext) => {
    const current = ctx.ui.getEditorText();
    if (slot === undefined && current === "") return;
    const captured: { text: string; restore?: () => boolean } = { text: current };
    const capturedEditor = active;
    const draft = capturedEditor && { text: capturedEditor.getText(), payloads: readPastes(capturedEditor) };
    const factory = installed;
    if (draft) captured.restore = () => {
      if (!active || (active !== capturedEditor && ctx.ui.getEditorComponent() !== factory)) return false;
      restoreRawDraft(active, draft.text, draft.payloads);
      return true;
    };
    if (!slot?.restore?.()) setText(ctx, slot?.text ?? "");
    slot = current === "" ? undefined : captured;
    ctx.ui.setStatus(
      "prompt-stash",
      slot === undefined ? undefined : "stash • draft saved",
    );
  };

  pi.on("session_start", (_event, ctx) => {
    slot = undefined;
    enabled = ctx.mode === "tui";
    ctx.ui.setStatus("prompt-stash", undefined);
  });
  // Runs after ALL session_start handlers, so vi composes in either load order.
  pi.on("resources_discover", (_event, ctx) => {
    if (!enabled || (installed && ctx.ui.getEditorComponent() === installed)) return;
    previous = ctx.ui.getEditorComponent();
    const base = previous;
    installed = (tui, theme, keybindings) => {
      const editor = base?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      if (editor instanceof CustomEditor) installSinglePassPasteExpansion(editor);
      return editor;
    };
    unregister?.();
    unregister = registerMainEditorBinding(ctx, { id: "prompt-stash", priority: 100, create(editor) {
      active = editor instanceof CustomEditor ? editor : undefined;
      return { key(data) {
        const lead = data.charCodeAt(0);
        const stashKey = lead === CTRL_S_BYTE || (lead === ESC && data.includes(CTRL_S_CODEPOINT));
        if (!enabled || !stashKey || !matchesKey(data, "ctrl+s")) return false;
        toggle(ctx);
        return true;
      } };
    } });
    ctx.ui.setEditorComponent(installed);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    enabled = false;
    unregister?.();
    unregister = undefined;
    slot = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
    if (installed && ctx.mode === "tui" && ctx.ui.getEditorComponent() === installed)
      ctx.ui.setEditorComponent(previous);
    installed = previous = undefined;
    active = undefined;
  });
}
