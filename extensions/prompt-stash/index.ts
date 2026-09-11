import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** One draft slot, scoped to this extension instance and never persisted. */
export default function promptStash(pi: ExtensionAPI): void {
  let slot: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    slot = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    slot = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
  });
  pi.registerShortcut("ctrl+shift+s", {
    description: "Stash, restore, or swap the current prompt",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      // Pi 0.85.1 getEditorText calls getExpandedText, including collapsed paste payloads.
      const current = ctx.ui.getEditorText();
      if (slot === undefined && current === "") return;
      const next = slot ?? "";
      ctx.ui.setEditorText(next);
      slot = current === "" ? undefined : current;
      ctx.ui.setStatus(
        "prompt-stash",
        slot === undefined ? undefined : "stash • draft saved",
      );
    },
  });
}
