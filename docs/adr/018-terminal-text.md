# 018: Shared terminal text policies

Status: accepted.

## Context

Footer, BTW, questionnaire, effort, todo and subagent views had separate rules
for untrusted terminal text. Some passed C1 controls or Unicode format characters
through. Questionnaire needed a separate newline fix for tab labels in #52.

## Decision

`extensions/terminal-text.ts` owns two pure string-to-string functions:

- `terminalLabel` removes terminal sequences, replaces residual Cc/Cf characters
  with spaces, repairs lone surrogates with U+FFFD, then collapses whitespace and
  trims. It produces one line without tabs.
- `terminalText` removes the same sequences and characters, retains LF, and
  normalizes CRLF and bare CR to LF. It preserves ordinary spaces, indentation
  and blank lines for Markdown and wrapping. Tabs expand to four spaces to retain Markdown nesting and code indentation.

Complete terminal sequences are deleted because their bytes are protocol, not
text. Residual controls become spaces to keep adjacent words separate. The
module consumes OSC, DCS, SOS, PM and APC payloads introduced by ESC or C1 through
BEL, ST or end of input before Node's VT stripper handles remaining sequences.
An unterminated string consumes the rest of the input. The final Cc/Cf pass
replaces terminal introducers even if a malformed sequence was not recognized.

All Cf characters are removed, including bidi controls, zero-width characters,
BOM and ZWJ/ZWNJ. Compound emoji and scripts using those joiners can therefore
change. Ordinary emoji, CJK and other printable Unicode remain intact. Labels
also fold Unicode whitespace and collapse repeated spaces; multi-line text
keeps printable spacing to preserve Markdown structure.

Each policy tests its input before replacing anything. Plain labels return
unchanged without regex replacement, retaining the footer's per-frame fast path.
Callers sanitize untrusted strings before adding theme ANSI or separators.
Wrapping, clipping, Markdown rendering and layout remain caller-owned.

This is a shared leaf utility, like `extensions/tool-path.ts`. It has no Pi
imports, lifecycle, registration, configuration or exported regexes. Each
extension still owns its Pi adapter and lifecycle, consistent with
[ADR 006](006-search-fast-power.md). No shared integration framework is added.

## Boundaries and verification

Questionnaire's draft/paste guard, todo input validation and the footer adapter's
identifier allowlist keep their separate purposes. PR URLs must already satisfy
`terminalLabel` before URL parsing; changed input is rejected rather than painted
or silently normalized. Generated ANSI stripping for hyperlink clipping measures
visible output and does not sanitize untrusted text.

The module's table tests both policies, including ESC/C1 sequences, terminated
and unterminated string payloads, controls, format characters, whitespace,
surrogates and printable Unicode. Extension tests prove adoption at rendered
interfaces; existing keyboard, state, wrapping and hyperlink regressions remain.
