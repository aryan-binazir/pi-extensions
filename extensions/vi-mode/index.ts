import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ViEditor } from "./editor.ts";
export default function viMode(pi: ExtensionAPI): void {
  let active: ViEditor | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      const draft = ctx.ui.getEditorText();
      active?.dispose();
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          (active = new ViEditor(tui, theme, keybindings)),
      );
      ctx.ui.setEditorText(draft);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    active?.dispose();
    active = undefined;
    if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
  });
}
