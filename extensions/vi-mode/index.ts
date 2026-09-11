import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEditorHandoff, readPastes, writePastes, retainRawText, placeCursor } from "./adapter.ts";
import { ViEditor } from "./editor.ts";
export default function viMode(pi: ExtensionAPI): void {
  let active: ViEditor | undefined;
  installEditorHandoff();
  let unsubscribe: (() => void) | undefined;
  const capture = (request: unknown) => {
    if (!active) return;
    const draft = active.getText(), payloads = readPastes(active);
    (request as { restore?: () => boolean }).restore = () => {
      if (!active) return false;
      active.setText("");
      retainRawText(active, draft);
      writePastes(active, payloads);
      placeCursor(active, draft.length);
      active.onChange?.(draft);
      return true;
    };
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      unsubscribe?.();
      unsubscribe = pi.events?.on("pi-interactive:stash-capture", capture);
      active?.dispose();
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          (active = new ViEditor(tui, theme, keybindings)),
      );
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribe?.();
    active?.dispose();
    active = undefined;
    if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
  });
}
