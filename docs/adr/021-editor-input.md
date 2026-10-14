# 021: One main-editor input pipeline and replacement owner

Status: accepted.

Vi, prompt stash and Escape Continue previously framed the same raw input three
times. Stash and Escape Continue decorated `handleInput` separately, and Vi and
Escape Continue independently wrapped editor replacement. Wrapper order made
the chord's Ctrl-S win over stash without declaring that precedence.

`extensions/editor-input.ts` owns main-editor input and replacement. Each editor
has one `PasteFramer` and one input wrapper. Vi installs its key/paste backend
when constructed, so direct editor use still works. Stock editors receive a
complete bracketed paste. Bindings register once with a stable ID, priority and
per-editor factory. The host registry is keyed by `sessionManager`; an editor
caches binding instances while looking up the live registry on every input.
Escape Continue declares priority 200 and stash 100. Higher numbers run first;
stable IDs break ties. A binding consumes a key by returning true. Paste data
never reaches bindings. A no-payload `beforePaste` callback flushes a pending
chord prefix, including when an opener is still incomplete.

The pipeline handles synchronous forwarding and programmatic re-entry. Native
recursive key dispatch bypasses framing; nested programmatic input bypasses
bindings while bracketed paste still passes through the framer. Input frames run in order, with focus checked between
callbacks. If a callback changes focus synchronously, the remaining input reaches that
focused component. A Vi draft reset during an unfinished paste discards the
payload through its closer, keeping its controls away from bindings. A fresh complete paste opener abandons that
discarded stream if its closer never arrives. Programmatic paste directed at
the main editor still reaches it while a dialog has focus. These
rules replace the old per-extension raw-chunk observers.

The sole `setCustomEditorComponent` owner snapshots the visible draft and paste
registry, retires its outgoing input state and cursor, calls Pi's replacement,
then attaches the pipeline and restores the registry. Vi destinations retain
raw inline whitespace; stock destinations keep Pi normalization. A rejected
factory or a reused Vi instance reacquires its cursor. Retiring an editor twice
cannot restore cursor settings over its replacement. The existing inline-dialog
`showExtensionCustom` compatibility transfer moves here unchanged.

Stash retains its factory solely to acquire its own editor and install
single-pass expansion. It adds no input decorator or replacement transfer.
Shutdown unregisters its binding and restores its factory only while it owns
it. Escape Continue keeps its session adapter and promotion policy unchanged;
its decorator now registers a chord binding and retains prefix timing and
registration cancellation. Replacement re-creates binding instances and
retires their timers automatically.

The module shares state on `InteractiveMode.prototype` through `Symbol.for`.
The first extension installs the wrappers; later loads replace implementation
functions in that state. Live editor wrappers call the shared dispatch function.
The existing editor-handoff state is reused when upgrading a running process.
The legacy immutable boolean handoff marker retains its original replacement
wrapper until restart; that legacy installation requires a restart before
new binding reattachment is supported. Legacy Escape Continue own-input decorators are detached
when the pipeline first attaches. `/reload` neither stacks wrappers nor keeps
old binding registrations active.

Pi reapplies stock cursor settings after reload and through `/settings`, without
replacing an editor. The render-time cursor repair from c5a384b therefore remains
necessary. This ADR centralizes replacement ownership, not personal settings.

Tests use real editor input and `InteractiveMode` replacement with the shared
[Pi-session harness](023-test-harness.md). They cover all six three-extension
orders, each extension alone, both stash/Escape Continue orders without Vi,
framing counts, chord precedence, fragmented control-byte pastes, replacement,
reload, latest implementations and cursor retirement/reacquisition. Existing
Vi, stash and Escape Continue behavioral tests remain the integration contract.
[ADR 001](001-editor.md) and [ADR 016](016-paste-framing.md) retain editing and
marker-recognition policy while this module owns input lifetime.
