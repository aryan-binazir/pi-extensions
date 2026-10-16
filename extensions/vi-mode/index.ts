import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installEditorInput } from "../editor-input.ts";
import { attachViMode, ViEditor } from "./editor.ts";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
export default function viMode(pi: ExtensionAPI): void {
  let dispose: (() => void) | undefined;
  let composed = false;
  installEditorInput();
  pi.on("session_start", () => {
    composed = false;
  });
  pi.on("resources_discover", (_event, ctx) => {
    if (!ctx.hasUI || composed) return;
    composed = true;
    const base = ctx.ui.getEditorComponent();
    const factory: EditorFactory = (tui, theme, keybindings) => {
      dispose?.();
      const editor = base?.(tui, theme, keybindings) ?? new ViEditor(tui, theme, keybindings);
      if (!(editor instanceof CustomEditor)) throw new Error("Vi mode requires a Pi CustomEditor");
      dispose = attachViMode(editor);
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    dispose?.();
    dispose = undefined;
    if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
  });
}
