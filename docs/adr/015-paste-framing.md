# 015: Share bracketed paste framing

Status: accepted.

Vi and prompt stash use `PasteFramer` from `extensions/vi-mode/paste-framing.ts`.
It owns marker recognition and buffering behind `feed`, `pasting`,
`holdingMarker` and `reset`. `feed` yields ordered raw key data or complete raw
paste payloads. Consumers exhaust the iterator before feeding the next chunk.
Vi retains payload decoding, sanitization, collapse, selection replacement and
undo; stash only observes framing and forwards raw input unchanged.

Outside a paste, hold a trailing opening-marker prefix only when it is at
least three bytes long. ESC and ESC [ are complete legacy keys, so opener
splits after one or two bytes do not reconstruct a paste. Join held fragments
with their continuation as one key if it is unrelated; discard abandoned
fragments before a fresh complete opener. Inside a paste, buffer through the
first complete closer, including a one-byte ESC fragment. Nested openers are
literal payload. A literal closer ends the paste because the protocol has no
escaping. Closing-marker fragments outside a paste are key data unless they
also match a held opening-marker prefix.

Frames are lazy so key callbacks run before the framer holds later bytes in
the same chunk. This preserves submission callbacks that replace the draft
before a stalled opener. Vi resets on draft replacement and disposal. It
handles keys spanning the original input internally and re-enters its decorated
input method for shorter key segments around pastes, preserving stash shortcuts
before and after a paste. Stash observes only outer inputs; recursive forwarding
already belongs to an observed chunk and must not overwrite framing state.
The observation has its own framer because stash also wraps the stock editor.

The shared rule fixes stash remaining in paste mode after a closer stalls at
one byte, stash holding a closing-only prefix outside a paste, and vi's
recursive key-prefix dispatch clearing stash's held opener. Table-driven framer
tests and real stock/vi input tests cover these corrections, raw forwarding,
legacy keys, callback ordering and undo. No observer mode or consumer-specific
marker policy is needed.
