# 001: A vi editor and independent draft stash

Status: accepted for Pi 0.85.1.

Pi's CustomEditor preserves application shortcuts, completion and submission. ViEditor extends it and owns modal editing, logical-line motions, operator ranges, text objects, registers and bounded undo history. Tests send real editor inputs and inspect submitted/expanded text and selection rendering. It starts in insert mode.

Supported keys are Escape, i/a/I/A/o/O, h/j/k/l, w/b/e, 0/^/$, gg/G, decimal counts, d/c/y with motions, dd/cc/yy, x/D/C, v/V, iw/aw/iW/aW and paired bracket/quote objects, named a-z and unnamed registers, p/P, u and Ctrl+R. This is a defined vi subset, not a complete Vim implementation. Search, macros, repeat-dot, marks and clipboard registers are not implemented.

Public APIs provide text reads, expanded paste reads, input, insertion and editor installation. They provide no cursor setter, and normalize tabs and carriage returns on text writes. `adapter.ts` isolates version-specific cursor writes, raw text retention, temporary display projection, paste registry snapshots and clearing Pi's separate undo history. It validates the private state shape and fails explicitly if incompatible. Development pins Pi 0.85.1 and regression tests cover actual editor inputs, raw pasted text, Unicode movement and undo. Upgrading Pi requires rerunning these tests.

Bracketed paste is buffered across input chunks and applied as a single undoable operation. Vi commands never interpret its contents. Character motions use grapheme boundaries, with each valid paste marker treated as one atomic unit. Pastes and public draft replacements exceeding 10 lines or 1000 characters use stock Pi marker formatting and its rendering registry. The adapter preserves safe raw whitespace instead of applying stock paste normalization. Undo snapshots retain the visible draft, cursor and copied payload registry; register yanks save expanded payloads and puts allocate fresh markers. Internal writes retain the registry, while public replacement clears it and creates a new collapsed draft. Insert-mode backspace removes a whole marker without stock registry renumbering. Expansion makes one replacement pass so marker-shaped text inside payloads stays literal. Visual mode renders highlighted character or logical-line selections. For rendering only, tabs project to four spaces, CR and other C0 controls to visible control symbols, and C1 controls to escaped hex text. Offset mapping puts the cursor and selection on the projected text. The adapter restores raw state in `finally`, including when rendering throws. This preserves safe payload bytes without sending pasted terminal control sequences or relying on terminal tab widths. Terminal cursor shape uses DECSCUSR, with a mode label as the fallback for terminals that ignore it. Linux PTY checks exercise the installed TUI, while cursor appearance in a real terminal emulator and macOS desktop behavior remain manual checks.

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


Review corrections sanitize text at draft ingestion, including bracketed paste, programmatic insertion and replacement. C0 controls other than tab/newline/carriage return, DEL and C1 controls are removed before any editor getter can expose them to streaming follow-ups, compaction queues, external editors or the transcript. Ordinary tabs, carriage returns and newlines remain byte-preserved in the draft and stash; normal submission additionally removes carriage returns. Unsafe terminal control bytes are never retained in the stash. Replacing a draft cancels visual selection and resets its anchor and viewport, preserving insert or normal mode.

Word motions and objects classify Unicode letters, numbers and combining marks as word characters. Missing objects cancel the pending operator without changing registers. Unsupported `r`, `m` and `q` commands consume one argument safely. Linewise operators retain or remove complete line boundaries, vertical motions retain the preferred column, and empty edits do not alter registers or undo. Counts saturate at 10,000; vertical movement computes its target directly and other loops stop at boundaries. A put that would grow a draft beyond 1 MiB is refused; pasted and typed drafts are not truncated. Grapheme boundaries are cached per draft. Pi's separate undo history is cleared after programmatic edits so its shortcut cannot resurrect another stashed draft.

Application key sequences reach Pi before pending vi arguments can consume them, preserving save and stash bindings. Submission clears custom undo and insertion history. Escape from insert mode moves onto the preceding grapheme. Register puts replace visual selections as one undoable operation and return to normal mode.

The additional approval pass found Pi 0.85.1 copies visible marker text without its registry during custom-editor replacement, before reload shutdown hooks. The adapter wraps the runtime's `InteractiveMode.setCustomEditorComponent` once and transfers visible text plus registry when a vi editor participates or a retained paste registry would otherwise be lost. A symbol prevents repeated wrapping across extension reloads. This is process-local compatibility code, not a settings change. Actual Pi method tests cover replacement before shutdown and reinstallation; upgrading Pi requires rerunning them. A subsequent default-to-default shutdown swap also preserves the retained registry. Questionnaire and effort use overlays so Pi never round-trips the draft through `setText` on dialog close.

The independently loadable stash optionally requests a restore closure through `pi-interactive:stash-capture`. When vi is active, that closure retains the visible draft and payload registry, preserving hand-typed prefixes/suffixes and long typed prose. Without vi, stash keeps its existing expanded-text fallback. Session shutdown removes the listener and invalidates the closure through the active-editor reference. Native non-insert mutations now checkpoint vi history, while public replacements and submission remain history resets. Kitty printable commands use Pi's decoder; bracketed paste decodes CSI-u control bytes before sanitization. Submission uses the actual completed value with single-pass marker expansion.

On transfer to the stock editor, inline text goes through stock `setText` normalization; only vi destinations retain raw inline CR/tab bytes because only vi has projected rendering. The copied collapsed payload registry is retained in either destination. Vi handoff and stash restoration notify `onChange` with the restored visible draft so Pi updates bash-mode styling and handling.
