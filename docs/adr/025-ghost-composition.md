# 025: Compose Vi with Ghost's editor

Status: accepted.

Ghost and Vi previously replaced each other's prompt editor. Vi now attaches its
controller to the CustomEditor selected after all `session_start` handlers, during
`resources_discover`. Ghost retains its editor instance, provider, commands and
shutdown lifecycle. A process-global disposer makes repeated attachment safe
across separately loaded module copies. Other editor types pass through unchanged.

The controller captures the editor's original input, rendering and text methods.
It wraps insertion and input-triggered text replacement as undoable edits while
preserving paste payloads. Public replacement and submission reset the draft.
It uses Ghost's public clear operation outside insert mode and before paste.
Ghost's async invalidation requires an explicit repaint on compiled Pi 1.0.2;
retired controllers suppress that repaint. Private Pi state access remains in the
existing adapter, apart from the captured TUI and border methods.

The Background models extension wraps the extension-facing registry's `stream`
and `complete` methods. Ghost sends a temperature that the Codex endpoint rejects,
and neither Ghost nor OMMS exposes the needed Pi-backend effort setting. The
wrapper removes Codex temperature and defaults Luna to low while preserving
explicit effort and main-runtime options. Shutdown restores its owned methods.
It must load before Ghost captures `stream` in `session_start`; machine setup
checks this order. It does not cover `streamSimple` or direct provider runtimes.

The pinned Ghost dev dependency runs in the normal check suite. Synthetic
providers exercise Codex options, both editor orders, token replacement, undo,
stash, paste and delayed responses without credentials or model calls.
