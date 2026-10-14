import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEditorInput } from "../editor-input.ts";
import { ViEditor } from "./editor.ts";
export default function viMode(pi: ExtensionAPI): void {
  let active: ViEditor | undefined;
  installEditorInput();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => {
          active?.dispose();
          return (active = new ViEditor(tui, theme, keybindings));
        },
      );
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    active?.dispose();
    active = undefined;
    if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
  });
}
