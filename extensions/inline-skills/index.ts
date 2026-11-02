import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, getKeybindings, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { installEditorInput, registerMainEditorBinding } from "../editor-input.ts";

const SKILL_TOKEN = /^[\w:.-]*$/;
const WHITESPACE = /\s/;
const WORD_START = /(?:^|[-_.:])(?=[^-_.:])/g;

function startsWord(value: string, token: string): boolean {
  const query = token.toLowerCase();
  const name = value.slice("skill:".length).toLowerCase();
  return value.toLowerCase().startsWith(query)
    || [...name.matchAll(WORD_START)].some(word => name.startsWith(query, word.index + word[0].length));
}

function inlineSlash(text: string, line: number, col: number): number | undefined {
  let tokenStart = col;
  while (tokenStart > 0 && !WHITESPACE.test(text[tokenStart - 1]!)) tokenStart--;
  if (text[tokenStart] !== "/" || tokenStart === col) return;
  const startsMessage = line === 0 && !text.slice(0, tokenStart).trim();
  if (startsMessage) return;
  return tokenStart;
}

export default function inlineSkills(pi: ExtensionAPI): void {
  let unregister: (() => void) | undefined;
  let lastMenuAt: { line: number; head: string } | undefined;
  const leftMenuToken = (text: string, line: number, col: number, triggers: readonly string[]): boolean => {
    if (!lastMenuAt || line !== lastMenuAt.line) return false;
    const slash = lastMenuAt.head.length;
    if (col <= slash) return text.slice(0, col) === lastMenuAt.head.slice(0, col);
    const typed = text.slice(slash + 1, col);
    return text.startsWith(`${lastMenuAt.head}/`) && !["@", "#", '"', ...triggers].some(trigger => typed.includes(trigger));
  };
  installEditorInput();

  const wrap = (current: AutocompleteProvider): AutocompleteProvider => {
    const ours = new WeakSet<AutocompleteItem>();
    return {
      triggerCharacters: current.triggerCharacters,
      shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
      async getSuggestions(lines, line, col, options) {
        const text = lines[line] ?? "";
        const slash = options.force ? undefined : inlineSlash(text, line, col);
        if (slash === undefined) {
          const left = !options.force && leftMenuToken(text, line, col, current.triggerCharacters ?? []);
          lastMenuAt = undefined;
          return left ? null : current.getSuggestions(lines, line, col, options);
        }
        lastMenuAt = { line, head: text.slice(0, slash) };
        const token = text.slice(slash + 1, col);
        const messageStartMenu = SKILL_TOKEN.test(token)
          ? await current.getSuggestions([`/${token}`], 0, token.length + 1, { signal: options.signal })
          : null;
        const items = messageStartMenu?.items.filter(item => item.value.startsWith("skill:") && startsWord(item.value, token)) ?? [];
        for (const item of items) ours.add(item);
        // No leading "/": Pi submits the message when Enter accepts a "/"-prefixed suggestion.
        return items.length ? { items, prefix: token } : null;
      },
      applyCompletion(lines, line, col, item, prefix) {
        if (!ours.has(item)) return current.applyCompletion(lines, line, col, item, prefix);
        lastMenuAt = undefined;
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
        const backspace = getKeybindings().matches(data, "tui.editor.deleteCharBackward");
        const editedBeforeCursor = backspace
          ? after.col < before.col && edited === text.slice(0, after.col) + text.slice(before.col)
          : (decodeKittyPrintable(data) !== undefined || data.charCodeAt(0) >= 32)
            && after.col > before.col && edited === text.slice(0, before.col) + edited.slice(before.col, after.col) + text.slice(before.col);
        const slash = editedBeforeCursor ? inlineSlash(edited, after.line, after.col) : undefined;
        if (slash === undefined) return true;
        lastMenuAt = { line: after.line, head: edited.slice(0, slash) };
        trigger.call(editor);
        return true;
      } };
    } });
  });
  pi.on("session_shutdown", () => {
    unregister?.();
    unregister = undefined;
    lastMenuAt = undefined;
  });
}
