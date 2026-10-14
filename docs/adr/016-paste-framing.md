# 016: Share bracketed paste framing

Status: accepted; per-extension framer ownership and re-entry superseded by [ADR 021](021-editor-input.md).

`PasteFramer` now lives at `extensions/paste-framing.ts`. It owns marker
recognition and buffering behind `feed`, `pasting`, `holdingMarker` and `reset`.
`feed` yields ordered raw key data or complete raw paste payloads using the rule
in [ADR 001](001-editor.md). `holdingMarker` reports an outside-paste opener
fragment; `pasting` covers the entire active payload, including closer fragments.
Payload chunks remain separate until a complete closer arrives; only a short
candidate closer is searched again.

Frames are lazy so key callbacks run before the framer holds later bytes in the
same chunk. Vi retains decoding, sanitization, collapse, selection replacement
and undo. The shared pipeline now owns the sole framer for each main editor,
centralizes re-entry and focus checks, and dispatches extension keys by declared
priority. Stash and Escape Continue no longer observe framing independently.
Draft replacement discards an incomplete Vi paste through its closing marker;
its remaining controls cannot become extension shortcuts.
