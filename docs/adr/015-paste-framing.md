# 015: Share bracketed paste framing

Status: accepted.

Vi and prompt stash use `PasteFramer` from `extensions/vi-mode/paste-framing.ts`.
It owns marker recognition and buffering behind `feed`, `pasting`,
`holdingMarker` and `reset`. `feed` yields ordered raw key data or complete raw
paste payloads using the rule in [ADR 001](001-editor.md). `holdingMarker`
reports an outside-paste opener fragment; `pasting` covers the entire active
payload, including closer fragments. Payload chunks remain separate until a
complete closer arrives; only a short candidate closer is searched again.
Vi retains decoding, sanitization, collapse, selection replacement and undo.
Stash observes framing and forwards raw input unchanged.

Frames are lazy so key callbacks run before the framer holds later bytes in
the same chunk. Re-entry is safe at a yield because framing state is idle;
re-fed key segments contain neither an opener nor a held trailing opener prefix.
Callbacks can reset the draft, and unconsumed bytes in the outer input still
run afterward. Vi resets on draft replacement and disposal. Key segments
shorter than the supplied chunk re-enter its decorated input method; whole
or reconstructed unsplit keys dispatch internally. This preserves existing
stash shortcuts around pastes and submission/reset ordering.

Stash has its own framer because it also wraps the stock editor. It observes
only outer input; recursive editor forwarding already belongs to that observed
chunk and must not overwrite its framing state. Stash retains its existing
lifetime without adding draft-replacement hooks.
