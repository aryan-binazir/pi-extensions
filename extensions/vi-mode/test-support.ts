import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { type TUI, type Terminal } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ViEditor } from "./editor.ts";
type EditorConstructor<T extends CustomEditor> = new (
  ...args: ConstructorParameters<typeof CustomEditor>
) => T;
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
/** Feed an editor one key at a time, the way a terminal delivers typing. */
export function keys(e: { handleInput(data: string): void }, input: string): void {
  for (const key of input) e.handleInput(key);
}
