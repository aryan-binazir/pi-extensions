import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC = 0x1b;
/** Legacy Ctrl+S byte, by the same code & 0x1f rule terminals use. */
const CTRL_S_BYTE = "s".charCodeAt(0) & 0x1f;
/** CSI u and modifyOtherKeys both spell the key out as a decimal codepoint. */
const CTRL_S_CODEPOINT = String("s".charCodeAt(0));
/** Bytes bracketed paste strips, so text holding them has to be set directly. */
const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/** One draft slot, scoped to this extension instance and never persisted. */
export default function promptStash(pi: ExtensionAPI): void {
  let slot: { text: string; restore?: () => boolean } | undefined;
  let installed: EditorFactory | undefined;
  let previous: EditorFactory | undefined;
  let enabled = false;

  /**
   * Bracketed paste keeps stock paste collapsing, but it strips control bytes
   * and a reduced UI adapter need not offer it, so those drafts go in directly.
   */
  const setText = (ctx: ExtensionContext, text: string) => {
    if (text && ctx.ui.pasteToEditor && !CONTROL_BYTES.test(text)) {
      ctx.ui.setEditorText("");
      ctx.ui.pasteToEditor(text);
    } else ctx.ui.setEditorText(text);
  };

  const toggle = (ctx: ExtensionContext) => {
    // Pi 0.85.1 getEditorText calls getExpandedText, including collapsed paste payloads.
    const current = ctx.ui.getEditorText();
    if (slot === undefined && current === "") return;
    const captured: { text: string; restore?: () => boolean } = { text: current };
    // Optional vi integration retains which spans were pasted versus hand typed.
    pi.events?.emit("pi-interactive:stash-capture", captured);
    if (!slot?.restore?.()) setText(ctx, slot?.text ?? "");
    slot = current === "" ? undefined : captured;
    ctx.ui.setStatus(
      "prompt-stash",
      slot === undefined ? undefined : "stash • draft saved",
    );
  };

  // Preserve expanded stock pastes when Pi copies only visible marker text
  // during factory replacement. Vi's existing handoff retains richer state.
  const replace = (ctx: ExtensionContext, factory: EditorFactory | undefined) => {
    const text = ctx.ui.getEditorText();
    ctx.ui.setEditorComponent(factory);
    if (ctx.ui.getEditorText() !== text) setText(ctx, text);
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
      const input = editor.handleInput.bind(editor);
      let pasting = false;
      let boundary = "";
      // Decorate the actual component, retaining its identity, callbacks,
      // focus, vi state and paste registry rather than proxying its internals.
      editor.handleInput = (data) => {
        const chunk = boundary === "" ? data : boundary + data;
        const wasPasting = pasting || boundary !== "";
        // Delimiters cannot overlap, so only the rightmost one sets the state.
        const closed = chunk.lastIndexOf(PASTE_END);
        const opened = chunk.indexOf(PASTE_START, closed < 0 ? 0 : closed + PASTE_END.length);
        if (opened >= 0) pasting = true;
        else if (closed >= 0) pasting = false;
        boundary = "";
        // Vi accepts paste delimiters split across terminal input chunks, so a
        // chunk ending in part of one holds that tail back for the next chunk.
        for (let size = 2; size < 6; size++) {
          const tail = chunk.slice(-size);
          if (tail.length === size && (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail)))
            boundary = tail;
        }
        // Ctrl+S is the raw byte or a CSI sequence naming its codepoint; ruling
        // the rest out keeps ordinary typing off the costly key parser.
        const lead = data.charCodeAt(0);
        const stashKey = lead === CTRL_S_BYTE || (lead === ESC && data.includes(CTRL_S_CODEPOINT));
        if (enabled && !wasPasting && !pasting && stashKey && matchesKey(data, "ctrl+s")) {
          toggle(ctx);
          tui.requestRender();
        } else input(data);
      };
      return editor;
    };
    replace(ctx, installed);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    enabled = false;
    slot = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
    // Core may already have reset the editor, or another extension may own it.
    if (installed && ctx.mode === "tui" && ctx.ui.getEditorComponent() === installed)
      replace(ctx, previous);
    installed = previous = undefined;
  });
}
