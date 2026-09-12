import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { type TUI, type Terminal } from "@earendil-works/pi-tui";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ViEditor } from "./editor.ts";
export function editor<T extends CustomEditor = ViEditor>(
  EditorClass: new (
    ...args: ConstructorParameters<typeof ViEditor>
  ) => T = ViEditor as unknown as new (
    ...args: ConstructorParameters<typeof ViEditor>
  ) => T,
) {
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
