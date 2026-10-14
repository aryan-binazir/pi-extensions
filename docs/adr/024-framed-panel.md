# 024: Shared collapsible framed panel

Status: accepted.

## Context

Todo and Subagents each implemented a compact summary, a shortcut toggle and a
border-blue expanded list. Their width fixes and row policies had drifted.
Todo wraps rows and clips the completed frame; Subagents truncates rows and
limits the panel to half the terminal height, with a five-line minimum.

## Decision

`extensions/framed-panel.ts` owns the expansion state and rendering for these
two views. `FramedPanel` takes the shortcut label and a `wrap` or `truncate`
policy. Callers register the shortcut, supply the themed summary and title,
and provide rows as an array or a capacity callback. The read-only `expanded`
property lets Subagents include the view choice in its paint deduplication key.

The module hides both states below six columns. Expanded frames reserve four
columns for borders and padding. Todo keeps ANSI-aware wrapping; Subagents
keeps a single padded line per row with its existing ellipsis. Every finished
line is clipped to the requested width with an empty marker. Fitting output,
including hint placement, remains unchanged.

An optional `maxHeight` counts the whole frame. The module reserves the title
and two borders before requesting rows and caps the resulting body. A cap below
three cannot fit an expanded frame; a cap below one also hides the compact line.
Subagents retains its half-terminal-height policy, nine row slots and five-line
minimum. Its capacity callback selects running children first and reserves a
slot for the exact hidden running/queued counts when needed. Those counts stay
with the caller because they describe tasks, not frame geometry.

One panel instance lasts for each extension load, including empty periods.
Toggling changes only that instance's view choice. Saved todos, reminders,
subagent registry wiring and commands retain their existing ownership.
Effort, questionnaire and BTW frames are non-goals because their layouts differ.

## Verification

The module's public render/toggle test covers widths 0, 5, 6, 7, 20 and 200,
ANSI, CJK, emoji, oversized graphemes, long rows, both row policies, height caps
and both states. Every line must fit its requested width. Literal frames fix
the expected fitting output and distinguish wrapping from truncation.

Each widget also exercises its registered shortcut and rendered output through
`tests/pi-session.ts`. Existing widget regressions retain their original
expectations. Local verification uses `npm run check` and an isolated real Pi
TUI drive of todo at 40 and 100 columns with one short model prompt.
