# 001: A vi editor and independent draft stash

Status: accepted for Pi 0.85.1.

Pi's CustomEditor preserves application shortcuts, completion and submission. ViEditor extends it and owns modal editing, logical-line motions, operator ranges, text objects, registers and bounded undo history. Tests send real editor inputs and inspect submitted/expanded text and selection rendering. It starts in insert mode.

Supported keys are Escape, i/a/I/A/o/O, h/j/k/l, w/b/e, 0/^/$, gg/G, decimal counts, d/c/y with motions, dd/cc/yy, x/D/C, v/V, iw/aw/iW/aW and paired bracket/quote objects, named a-z and unnamed registers, p/P, u and Ctrl+R. This is a defined vi subset, not a complete Vim implementation. Search, macros, repeat-dot, marks, f/F/t/T character motions and clipboard registers are not implemented.

Public APIs provide text reads, expanded paste reads, input, insertion and editor installation. They provide no cursor setter, and normalize tabs and carriage returns on text writes. `adapter.ts` isolates version-specific cursor writes, raw text retention, temporary display projection, paste registry snapshots, clearing Pi's separate undo history and cancelling its autocomplete. It validates the private state shape and fails explicitly if incompatible. Development pins Pi 0.85.1 and regression tests cover actual editor inputs, raw pasted text, Unicode movement and undo. Upgrading Pi requires rerunning these tests.

Paste handling:

- Pi's input buffer delivers each bracketed paste as one input, applied as a single undoable operation. Vi commands never interpret its contents. If a read stalls inside the opening marker, Pi forwards the fragment and then single characters; vi holds a trailing partial opener of three or more bytes until it completes. A lone ESC or `ESC [` is a complete legacy key (Escape, Alt+[) and is never held; prompt stash applies the same rule outside a paste.
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

The wrapper captures the existing factory with `getEditorComponent` and installs
through `setEditorComponent` during `resources_discover`, after all extensions'
`session_start` handlers. This composes with vi in either load order. It decorates
the actual editor so identity, focus, callbacks and paste integration remain
intact. Vi disposes its previous instance whenever its factory is reinvoked.
Repeated discovery does not stack wrappers. Shutdown disables old input handlers
and restores the previous factory only if stash still owns it. Other extensions
that replace the editor later must compose with the current factory themselves.
Expanded stock paste text is recovered if Pi's factory transfer loses its marker
registry; vi's existing handoff retains the richer visible draft and registry.
The slot is memory-only and clears on session start/shutdown, including reload,
resume and fork. Nonempty drafts swap; empty drafts restore and empty the slot.


Text is sanitized at draft ingestion, including bracketed paste, programmatic insertion and replacement. C0 controls other than tab/newline/carriage return, DEL and C1 controls are removed before any editor getter can expose them to streaming follow-ups, compaction queues, external editors or the transcript. Ordinary tabs, carriage returns and newlines remain byte-preserved in the draft and stash; normal submission additionally removes carriage returns. Unsafe terminal control bytes are never retained in the stash. Replacing a draft cancels visual selection and resets its anchor and viewport, preserving insert or normal mode.

Word motions and objects classify Unicode letters, numbers and combining marks as word characters. Missing objects cancel the pending operator without changing registers. Unsupported `r`, `m`, `q`, `f`, `F`, `t` and `T` commands cancel any pending operator, count or register and consume one argument safely. Their arguments and register names are read before undo/redo, so a `u` or Ctrl+R argument never runs; an invalid register name cancels the pending command. A `u` or Ctrl+R after a `g` prefix or a pending text object still cancels it and undoes or redoes. Linewise operators retain or remove complete line boundaries, vertical motions retain the preferred column, and empty edits do not alter registers or undo. Counts saturate at 10,000; vertical movement computes its target directly and other loops stop at boundaries. A put that would grow a draft beyond 1 MiB is refused; pasted and typed drafts are not truncated. Grapheme boundaries are cached per draft. Pi's separate undo history is cleared after programmatic edits so its shortcut cannot resurrect another stashed draft.

Application key sequences reach Pi before pending vi arguments can consume them, preserving save and stash bindings; a native edit outside insert mode cancels pending vi commands. Without Kitty support Pi enables xterm modifyOtherKeys, so vi decodes its plain and Shift printables (lock bits ignored) with a local mirror of Pi's unexported decoder and runs them like legacy keys. Submission clears custom undo and insertion history. Escape from insert mode moves onto the preceding grapheme and, in the same keypress, closes Pi's completion popup and cancels its pending request; vi cursor motions also close it, so Enter or Tab cannot apply a stale prefix. In normal mode with nothing pending, Escape still reaches Pi, closing a popup or interrupting as stock does. Register puts replace visual selections as one undoable operation and return to normal mode.

Pi 0.85.1 copies visible marker text without its registry during custom-editor replacement, before reload shutdown hooks. The adapter wraps the runtime's `InteractiveMode.setCustomEditorComponent` once and transfers visible text plus registry when a vi editor participates or a retained paste registry would otherwise be lost. A symbol prevents repeated wrapping across extension reloads. This is process-local compatibility code, not a settings change. Actual Pi method tests cover replacement before shutdown and reinstallation; upgrading Pi requires rerunning them. A subsequent default-to-default shutdown swap also preserves the retained registry. Effort and BTW use overlays, so Pi never round-trips the draft through `setText` on dialog close. The questionnaire (`overlay: false`) and subagent workflow review render inline, so the adapter also wraps `showExtensionCustom` once: for a vi editor, Pi's close-time `setText` receives the expanded draft and the adapter then restores the visible draft and registry. Each extension load, including every load after `/reload`, evaluates its own copy of `adapter.ts`, while the first wrappers stay installed, so keys shared across copies (the vi marker, the single-pass expansion marker and the text-cache invalidation hook) use `Symbol.for`. The wrappers and the `adapter.ts` helpers and keys they call stay those of the first copy, so changes to them take effect only after restarting Pi, not on `/reload`.

The independently loadable stash optionally requests a restore closure through `pi-interactive:stash-capture`. When vi is active, that closure retains the visible draft and payload registry, preserving hand-typed prefixes/suffixes and long typed prose. Without vi, stash keeps its existing expanded-text fallback. Session shutdown removes the listener and invalidates the closure through the active-editor reference. Native non-insert mutations now checkpoint vi history, while public replacements and submission remain history resets. Kitty printable commands use Pi's decoder; bracketed paste decodes CSI-u control bytes before sanitization. Submission uses the actual completed value with single-pass marker expansion.

On transfer to the stock editor, inline text goes through stock `setText` normalization; only vi destinations retain raw inline CR/tab bytes because only vi has projected rendering. The copied collapsed payload registry is retained in either destination. Vi handoff and stash restoration notify `onChange` with the restored visible draft so Pi updates bash-mode styling and handling.
