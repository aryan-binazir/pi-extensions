# 001: A vi editor and independent draft stash

Status: accepted; editor input and replacement ownership superseded by [ADR 021](021-editor-input.md). Editor adapter SDK baselines are Pi 0.85.1 and 0.99.1; Escape Continue also has TUI verification on Pi 0.87.1, 1.0.2 and 1.2.0.

Pi's CustomEditor preserves application shortcuts, completion and submission. Vi attaches modal editing, logical-line motions, operator ranges, text objects, registers and bounded undo history to the active CustomEditor. The standalone ViEditor constructor creates a CustomEditor with the same attachment. Tests send real editor inputs and inspect submitted/expanded text and selection rendering. It starts in insert mode.

Supported keys:

- Escape, `i/a/I/A/o/O`, `h/j/k/l`, `w/b/e`, `W/B/E`, `ge/gE`, `0/^/$`, `gg/G` and decimal counts.
- `f/F/t/T{char}` on the current line, `;` to repeat and `,` to repeat in the opposite direction. Failed finds cancel pending operators. Find and replace arguments accept one grapheme, including decoded Kitty and modifyOtherKeys printables. Legacy surrogate-pair key frames are reassembled before argument validation.
- `d/c/y` and `gu/gU/g~` with motions or text objects; `dd/cc/yy`, doubled case operators, `x/X/D/C/s/S/Y/J/~`, and normal-mode `r{char}`. `Y` means `y$`, following Neovim's default. Counts on `$`, `D`, `C` and `Y` reach the end of a later logical line.
- `v/V`, visual `o/O` to swap selection ends, visual `u/U/~` for case changes, visual `s` to change the selection, and visual `X/D/Y/C/S` for whole selected lines. Visual `J` joins selected lines, with a minimum of two.
- `iw/aw/iW/aW`, paired bracket/quote objects, and `ib/ab/iB/aB` as aliases for parentheses and braces.
- Named `a-z` and unnamed registers, `p/P`, normal-mode `u` and Ctrl+R.

This remains a defined vi subset. `/` and `?` are unmapped in normal and visual modes, like other unsupported keys: they cancel a pending count, operator or prefix and change nothing else. Ctrl+G opens the draft in an external editor for anything beyond this subset.

Search, `n/N`, `*`/`#`, macros, repeat-dot, marks, paragraph motions, indentation operators, percent-count jumps and clipboard registers are not implemented. `r<Enter>` and visual-mode `r` are unsupported. Case changes preserve characters whose JavaScript mapping expands to multiple code points, so `ß` and `İ` stay unchanged. Neovim instead maps them to `ẞ` and `i`.

Public APIs provide text reads, expanded paste reads, input, insertion and editor installation. They provide no cursor setter, and normalize tabs and carriage returns on text writes. `adapter.ts` isolates version-specific cursor writes, raw text retention, temporary display projection, paste registry snapshots, clearing Pi's separate undo history and cancelling its autocomplete. It validates the private state shape and fails explicitly if incompatible. Development pins Pi 0.99.1 and regression tests cover actual editor inputs, raw pasted text, Unicode movement and undo. Upgrading Pi requires rerunning these tests.

Paste handling:

- Pi's input buffer normally delivers each bracketed paste as one input, applied as a single undoable operation. Vi commands never interpret its contents. The [shared main-editor pipeline](021-editor-input.md) owns one [paste framer](016-paste-framing.md). Outside a paste it holds only trailing opening-marker prefixes of three or more bytes. A lone ESC or `ESC [` is a complete legacy key and is never held. Inside a paste it buffers through the first complete closing marker, including closer fragments of any length. Bindings receive only key frames; Vi receives complete payloads.
- Character motions use grapheme boundaries, with each valid paste marker treated as one atomic unit.
- Pastes and public draft replacements exceeding 10 lines or 1000 characters use stock Pi marker formatting and its rendering registry. The adapter preserves safe raw whitespace instead of applying stock paste normalization.
- Expansion makes one replacement pass so marker-shaped text inside payloads stays literal.

Registry and undo:

- Undo snapshots retain the visible draft, cursor and copied payload registry; register yanks save expanded payloads and puts allocate fresh markers.
- Internal writes retain the registry, while public replacement clears it and creates a new collapsed draft.
- Insert-mode backspace removes a whole marker without stock registry renumbering.

Rendering is display-only. Visual mode renders highlighted character or logical-line selections. Tabs project to four spaces, CR and other C0 controls to visible control symbols, and C1 controls to escaped hex text; offset mapping puts the cursor and selection on the projected text. The adapter restores raw state in `finally`, including when rendering throws. This preserves safe payload bytes without sending pasted terminal control sequences or relying on terminal tab widths.

Terminal cursor shape uses DECSCUSR, with a mode label as the fallback for terminals that ignore it. Linux PTY checks exercise the installed TUI, while cursor appearance in a real terminal emulator and macOS desktop behavior remain manual checks.

Prompt stash handles Ctrl+S in the main editor's input method, not through
`registerShortcut` or a global terminal hook. Pi's model/thinking save and
session-selector Ctrl+S bindings therefore remain untouched and produce no
registration warning. Both legacy and Kitty Ctrl+S work; distinct Kitty
Ctrl+Shift+S passes through. No keybindings configuration is required.

Stash captures the existing factory with `getEditorComponent` and installs
through `setEditorComponent` during `resources_discover`, after all extensions'
`session_start` handlers. The factory only acquires an editor and enables
single-pass paste expansion. Its key binding registers with the shared pipeline,
which preserves editor identity, focus and callbacks and reattaches after any
replacement. Later factories do not have to compose input decorators. Repeated
discovery does not stack wrappers. Shutdown unregisters the binding and restores
the previous factory only if stash still owns it. The shared replacement owner
transfers the visible draft and paste registry.
The slot is memory-only and clears on session start/shutdown, including reload,
resume and fork. Nonempty drafts swap; empty drafts restore and empty the slot.


Text is sanitized at draft ingestion, including bracketed paste, programmatic insertion and replacement. C0 controls other than tab/newline/carriage return, DEL and C1 controls are removed before any editor getter can expose them to streaming follow-ups, compaction queues, external editors or the transcript. Ordinary tabs, carriage returns and newlines remain byte-preserved in the draft and stash; normal submission additionally removes carriage returns. Unsafe terminal control bytes are never retained in the stash. Replacing a draft cancels visual selection and resets its anchor and viewport, preserving insert or normal mode.

Word motions and objects classify Unicode letters, numbers and combining marks as word characters. WORD motions group all non-whitespace characters. `w/W` stop on empty lines; their final operator step stops at the end of a nonempty line. Vim's exclusive-to-linewise promotion is not implemented. Missing objects cancel the pending operator without changing registers. Unsupported `m/q`, and `r` outside normal mode or with a pending operator, cancel pending commands and consume one argument safely. Find/replace arguments and register names precede undo/redo, so a `u` or Ctrl+R argument never runs; an invalid register name cancels the pending command. `gu/gU/g~` start case operators; Ctrl+R after a `g` prefix and undo/redo after a pending text-object prefix still cancel it and undo or redo. Linewise operators retain or remove complete line boundaries, vertical motions retain the preferred column, and empty edits do not alter registers or undo. Counts saturate at 10,000 after multiplying operator and motion counts; vertical movement computes its target directly and other loops stop at boundaries. Puts and `r` replacements that would grow an expanded draft beyond 1 MiB are refused; pasted and typed drafts are not truncated. Grapheme boundaries are cached per draft. Pi's separate undo history is cleared after programmatic edits so its shortcut cannot resurrect another stashed draft.

`r`, joins and case transformations each form one undo step. `s/S` group deletion and subsequent insertion together. Replacement and case changes leave registers intact. Character finds ignore collapsed marker labels; replacement treats a marker as one whole character. Case changes preserve markers and their payloads. `%` matches nested `()[]{}` across lines, starting at the first bracket at or after the cursor on the current line, and ignores marker labels. An unmatched bracket cancels a pending operator.

Application shortcuts reach Pi before pending vi arguments can consume them, preserving save and stash bindings. Enter or a submit binding cancels a pending find/replace argument without submitting. Arrow keys retain priority over pending arguments; a native edit outside insert mode cancels pending vi commands. Without Kitty support Pi enables xterm modifyOtherKeys, so vi decodes its plain and Shift printables (lock bits ignored) with a local mirror of Pi's unexported decoder and runs them like legacy keys. Submission clears custom undo and insertion history. Escape from insert mode moves onto the preceding grapheme and, in the same keypress, closes Pi's completion popup and cancels its pending request; vi cursor motions also close it, so Enter or Tab cannot apply a stale prefix. In normal mode with nothing pending, Escape still reaches Pi, closing a popup or interrupting as stock does. Register puts replace visual selections as one undoable operation and return to normal mode.

Pi copies visible marker text without its registry during custom-editor replacement, before reload shutdown hooks. [ADR 021](021-editor-input.md) assigns replacement to `extensions/editor-input.ts`. It releases the outgoing Vi cursor before creating the incoming editor, transfers the visible draft and registry, and attaches the pipeline. Runtime settings can still overwrite the cursor after replacement, so Vi retains its render-time repair. Effort and BTW use overlays. Inline questionnaire and workflow dialogs round-trip the draft through `setText`; the shared owner retains the `showExtensionCustom` compatibility wrapper for those dialogs. Process-global symbols preserve editor markers and shared implementations across reload. A process carrying the old immutable boolean handoff marker keeps its original replacement wrapper until restart.

The independently loadable stash captures the visible draft and payload registry directly from the current CustomEditor its binding attaches to. Vi decorates that same instance, preserving raw text, hand-typed prefixes/suffixes and long typed prose. Restoration uses the snapshot while that editor remains active, including when Vi wraps stash's factory, or when stash's factory recreates it. If another factory replaces the editor, stash restores expanded text through the current UI instead. Session shutdown clears the slot and active-editor reference. Native non-insert mutations and custom-editor input replacements checkpoint Vi history; public replacements and submission remain history resets. Kitty printable commands use Pi's decoder; bracketed paste decodes CSI-u control bytes before sanitization. Submission uses the actual completed value with single-pass marker expansion.

On transfer to the stock editor, inline text goes through stock `setText` normalization; only vi destinations retain raw inline CR/tab bytes because only vi has projected rendering. The copied collapsed payload registry is retained in either destination. Vi handoff and stash restoration notify `onChange` with the restored visible draft so Pi updates bash-mode styling and handling.
