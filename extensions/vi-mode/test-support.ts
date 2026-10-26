import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { TuiAltScreen, type TUI, type Terminal } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ViEditor } from "./editor.ts";
type EditorConstructor<T extends CustomEditor> = new (
  ...args: ConstructorParameters<typeof CustomEditor>
) => T;
const theme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedPrefix: (s: string) => s,
    selectedText: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};
export function editor(): ViEditor;
export function editor<T extends CustomEditor>(EditorClass: EditorConstructor<T>): T;
export function editor(EditorClass: EditorConstructor<CustomEditor> = ViEditor): CustomEditor {
  const terminal = {
    rows: 30,
    columns: 80,
    write() {},
    start() {},
    stop() {},
    hideCursor() {},
    showCursor() {},
  } as unknown as Terminal;
  let showHardwareCursor = false;
  return new EditorClass(
    {
      terminal,
      requestRender() {},
      getShowHardwareCursor: () => showHardwareCursor,
      setShowHardwareCursor: (show: boolean) => { showHardwareCursor = show; },
    } as unknown as TUI,
    theme,
    new KeybindingsManager(),
  );
}
export function keys(e: { handleInput(data: string): void }, input: string): void {
  for (const key of input) e.handleInput(key);
}
export function fullscreenEditor(): { tui: TuiAltScreen; editor: ViEditor; input(data: string): void } {
  let onInput: ((data: string) => void) | undefined;
  const terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start(input: (data: string) => void) { onInput = input; },
    stop() {},
    drainInput: async () => {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal);
  const editor = new ViEditor(tui, theme, new KeybindingsManager());
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  return { tui, editor, input: data => onInput!(data) };
}
