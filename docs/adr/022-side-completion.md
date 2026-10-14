# 022: Bounded tool-free side completions

Status: accepted.

## Context

BTW and the subagent tracker independently resolved authentication, applied
endpoint overrides, normalized a tool-free context and consumed provider streams.
Both needed the normalization repair in #59. Their native OpenAI and Codex wire
tests duplicated request serialization checks. BTW also carried the Claude
bridge cache-retention rule from #77 and the captured main-turn prompt rule from
#79.

## Decision

`extensions/side-completion.ts` exports one async `sideCompletion(request)`
function. The request contains the selected model, a registry for authentication
and provider lookup, system prompt, user messages, character/token limits and an abort
signal. Optional reasoning, session ID, start/text callbacks and a final-versus-
delta text choice preserve the two existing callers' request and display policies.
It returns bounded text or a discriminated failure carrying bounded text and,
for thrown errors and aborts, the original error value. Auth failures and
provider error events carry an `Error` built from their message; an unavailable
provider has only its failure kind. Caller wording and error clipping stay
outside the module.

The module resolves auth, applies its `baseUrl`, forwards headers/environment,
normalizes `tools: []` and calls the provider's public simple stream. It forwards
the caller's token budget unchanged. BTW bounds that budget against a usable
model maximum; the tracker retains its fixed 1,024-token request. Claude bridge
uses short cache retention because bridge 0.9.2 treats `none` as its verbatim summarizer path.
Other providers use `none`. Callers do not handle these request options.
Messages accept only `UserMessage[]`, matching both callers' inert snapshot/history
projection. A generic `Message[]` would also admit system tool declarations that
Pi preserves even with `tools: []`. Those are outside this module's interface.

Deltas stop at the character limit, including an exact-limit delta, and abort
the transport. Final text is bounded across text blocks without aborting a
completed transport. Tool-use completions are failures and no tool executes.
Provider errors, unavailable providers, cancellation, empty text and streams
without a completion have distinct failure kinds. Authentication and iteration
race cancellation, including providers that ignore their signal. Iterator cleanup
is requested without waiting for a stuck provider. Successful completion does
not abort the caller's signal.

BTW selects final-message text and receives bounded deltas for live rendering.
It maps cap and tool-use failures to its existing statuses and keeps their text
in followup history. Provider failures retain their draft in the overlay and stay
out of history. BTW's existing incomplete-stream policy also stays: partial text
joins history; no text shows "Provider returned no text" and retains an empty
answer. The module reports the incomplete failure rather than calling it a
successful completion. The tracker selects delta text, accepts a nonempty capped
report and rejects incomplete, empty and tool-use reports. Its fingerprint,
minute cadence, deadline and prompt remain in `tracker.ts`.

BTW owns snapshot projection, retained-tail compaction compatibility, overlay UI
and history. Its projection chooses the last main-agent turn's prompt for the
bridge and preserves that complete prompt for matching the provider's capture.
That choice requires session history, which this module does not receive. The
tracker still selects only `openai-codex/gpt-6-luna`; the shared bridge rule is
therefore dormant for it. No tracker bridge bug is fixed on an active path.

## Relationship to independent extensions

Like the root leaf modules in [ADR 018](018-terminal-text.md), this module has two
production consumers and one small interface. It imports Pi provider types and
normalization, but has no extension registration, lifecycle, events, configuration,
session state or UI. Each extension still owns its Pi adapter. It is a provider
call module, consistent with the independent entrypoints in
[ADR 000](000-package.md) and the no-integration-framework decision in
[ADR 006](006-search-fast-power.md). It is not a manifest entrypoint.

## Verification

`tests/side-completion.test.ts` owns synthetic event tests for bounds, failures,
cancellation, incomplete streams, caller token budgets, endpoint overrides and bridge
cache policy. Real OpenAI, Codex and pi-messages serializers use injected fetch
responses and synthetic credentials. Native wire tests and BTW's pi-messages
transport fixture moved out of caller tests. BTW tests retain prompt projection,
final text/history, status and overlay checks; tracker tests retain exact prompt,
model, observations, reports, cadence and generation checks. No Pi session is
needed for the module, so the real-session harness in ADR 023 is not involved.

Local verification is `npm run check`. A real Pi TUI drive separately checks BTW
answering and close-during-request cancellation. Tracker runtime behavior is
covered by tests only. Fast Mode's existing provider wrapper remains a separate
provider integration and still calls the simple stream directly.
