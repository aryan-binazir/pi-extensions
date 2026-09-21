import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEditorHandoff, readPastes, restoreRawDraft } from "./adapter.ts";
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
      restoreRawDraft(active, draft, payloads);
      return true;
    };
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      unsubscribe?.();
      unsubscribe = pi.events?.on("pi-interactive:stash-capture", capture);
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => {
          // A composing extension can invoke this factory again after startup.
          active?.dispose();
          return (active = new ViEditor(tui, theme, keybindings));
        },
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
