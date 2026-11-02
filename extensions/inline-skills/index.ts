import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, getKeybindings, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { installEditorInput, registerMainEditorBinding } from "../editor-input.ts";

const SKILL_TOKEN = /^[\w:.-]*$/;
const WHITESPACE = /\s/;
const WORD_START = /(?:^|[-_.:])(?=[^-_.:])/g;

/** Stricter than Pi's fuzzy match, which would turn most mid-message paths (`/tmp`) into a skill menu. */
function startsWord(value: string, token: string): boolean {
  const query = token.toLowerCase();
  const name = value.slice("skill:".length).toLowerCase();
  return value.toLowerCase().startsWith(query)
    || [...name.matchAll(WORD_START)].some(word => name.startsWith(query, word.index + word[0].length));
}

/** Index of the `/` that starts the token ending at `col`, unless it starts the message (Pi's own menu). */
function inlineSlash(text: string, line: number, col: number): number | undefined {
  let start = col;
  while (start > 0 && !WHITESPACE.test(text[start - 1]!)) start--;
  if (text[start] !== "/" || start === col) return;
  if (line === 0 && !text.slice(0, start).trim()) return;
  return start;
}

export default function inlineSkills(pi: ExtensionAPI): void {
  let unregister: (() => void) | undefined;
  // Where our last menu was requested. Pi re-queries an open menu on every edit and cursor move, and a
  // request can resolve after a burst of keys; stepping off the token must close it, not list files.
  let anchor: { line: number; head: string } | undefined;
  const leftToken = (text: string, line: number, col: number, triggers: readonly string[]): boolean => {
    if (!anchor || line !== anchor.line) return false;
    const slash = anchor.head.length;
    if (col <= slash) return text.slice(0, col) === anchor.head.slice(0, col);
    const typed = text.slice(slash + 1, col);
    return text.startsWith(`${anchor.head}/`) && !["@", "#", '"', ...triggers].some(trigger => typed.includes(trigger));
  };
  installEditorInput();

  const wrap = (current: AutocompleteProvider): AutocompleteProvider => {
    const ours = new WeakSet<AutocompleteItem>();
    return {
      triggerCharacters: current.triggerCharacters,
      shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
      async getSuggestions(lines, line, col, options) {
        const slash = options.force ? undefined : inlineSlash(lines[line] ?? "", line, col);
        if (slash === undefined) {
          const left = !options.force && leftToken(lines[line] ?? "", line, col, current.triggerCharacters ?? []);
          anchor = undefined;
          return left ? null : current.getSuggestions(lines, line, col, options);
        }
        anchor = { line, head: lines[line]!.slice(0, slash) };
        const token = lines[line]!.slice(slash + 1, col);
        // Pi's start-of-message matcher, so ranking and descriptions match its menu.
        const result = SKILL_TOKEN.test(token)
          ? await current.getSuggestions([`/${token}`], 0, token.length + 1, { signal: options.signal })
          : null;
        const items = result?.items.filter(item => item.value.startsWith("skill:") && startsWord(item.value, token)) ?? [];
        for (const item of items) ours.add(item);
        // No leading "/": Pi submits the message when Enter accepts a "/"-prefixed suggestion.
        return items.length ? { items, prefix: token } : null;
      },
      applyCompletion(lines, line, col, item, prefix) {
        if (!ours.has(item)) return current.applyCompletion(lines, line, col, item, prefix);
        anchor = undefined;
        const text = lines[line] ?? "";
        const start = col - prefix.length - 1;
        if (inlineSlash(text, line, col) !== start) return { lines: [...lines], cursorLine: line, cursorCol: col };
        const rest = text.slice(col);
        const next = [...lines];
        next[line] = `${text.slice(0, start)}/${item.value}${WHITESPACE.test(rest[0] ?? "") ? "" : " "}${rest}`;
        return { lines: next, cursorLine: line, cursorCol: start + item.value.length + 2 };
      },
    };
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider(wrap);
    unregister?.();
    // Pi only auto-opens completions for "/" at the message start and refuses "/" as a trigger character.
    unregister = registerMainEditorBinding(ctx, { id: "inline-skills", priority: 0, create(editor, forward) {
      const trigger = (editor as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete;
      return { key(data) {
        if (typeof trigger !== "function" || editor.isShowingAutocomplete()) return false;
        const before = editor.getCursor();
        const text = editor.getLines()[before.line] ?? "";
        forward(data);
        const after = editor.getCursor();
        if (after.line !== before.line || editor.isShowingAutocomplete()) return true;
        const edited = editor.getLines()[before.line] ?? "";
        // Typed or backspaced right before the cursor, as Pi's own slash menu reopens; vi normal mode does neither.
        const changed = getKeybindings().matches(data, "tui.editor.deleteCharBackward")
          ? after.col < before.col && edited === text.slice(0, after.col) + text.slice(before.col)
          : (decodeKittyPrintable(data) !== undefined || data.charCodeAt(0) >= 32)
            && after.col > before.col && edited === text.slice(0, before.col) + edited.slice(before.col, after.col) + text.slice(before.col);
        const slash = changed ? inlineSlash(edited, after.line, after.col) : undefined;
        if (slash === undefined) return true;
        anchor = { line: after.line, head: edited.slice(0, slash) };
        trigger.call(editor);
        return true;
      } };
    } });
  });
  pi.on("session_shutdown", () => {
    unregister?.();
    unregister = undefined;
    anchor = undefined;
  });
}
