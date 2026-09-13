import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** One draft slot, scoped to this extension instance and never persisted. */
export default function promptStash(pi: ExtensionAPI): void {
  let slot: { text: string; restore?: () => boolean } | undefined;
  pi.on("session_start", (_event, ctx) => {
    slot = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    slot = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
  });
  pi.registerShortcut("ctrl+s", {
    description: "Stash, restore, or swap the current prompt",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      // Pi 0.85.1 getEditorText calls getExpandedText, including collapsed paste payloads.
      const current = ctx.ui.getEditorText();
      if (slot === undefined && current === "") return;
      const captured: { text: string; restore?: () => boolean } = { text: current };
      // Optional vi integration retains which spans were pasted versus hand typed.
      pi.events?.emit("pi-interactive:stash-capture", captured);
      if (!slot?.restore?.()) {
        // Bracketed paste strips control bytes; reduced UI adapters may lack it.
        const hasControlBytes = slot && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(slot.text);
        if (slot && ctx.ui.pasteToEditor && !hasControlBytes) {
          ctx.ui.setEditorText("");
          ctx.ui.pasteToEditor(slot.text);
        } else ctx.ui.setEditorText(slot?.text ?? "");
      }
      slot = current === "" ? undefined : captured;
      ctx.ui.setStatus(
        "prompt-stash",
        slot === undefined ? undefined : "stash • draft saved",
      );
    },
  });
}
