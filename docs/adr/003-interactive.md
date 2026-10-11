# ADR 003: Disposable interactive dialogs and provider boundary

Status: accepted

Questionnaire, effort and BTW are independent Pi entrypoints. Each registers its
own command/tool and closes active UI on session shutdown. They use public Pi
custom UI components, model APIs and lifecycle hooks.

Questionnaire uses one stateful dialog with typed answers keyed by unique question
IDs. A single question submits on selection; multiple questions require a final
submit tab. Cancelling discards partial answers. The event
`pi-interactive:questionnaire-waiting` carries `{toolCallId, waiting}` and is cleared
in `finally`, including abort and UI failures. No persistence is implied by this
transient event.

Effort obtains levels from Pi's `getSupportedThinkingLevels`, including holes and
provider-specific extended levels. `setThinkingLevel` and `setModel` change session
state without touching saved defaults. `/effort new [LEVEL] [provider/model]`
uses the replacement runtime's event subscriber: the old session-bound API is
invalid after `newSession`. Node's process event emitter transfers plain model/level
values and an acknowledgement only after replacement. Ordinary new sessions do
not inherit a pending override. Pi's own `pi.events` facade also becomes stale
after replacement, so it cannot carry this handoff; listeners on the namespaced
process event are removed during shutdown and installed by the new runtime.

BTW serializes Pi's compacted context into inert text and invokes the selected
provider's public `streamSimple` with resolved Pi authentication and `tools: []`.
It does not create a Pi agent or execute model-requested tools. It preserves tool result
text, current system prompt, and an in-memory bounded followup history. Closing
aborts the request and discards all local conversation state; no answer is added
to the main session. It caps snapshot and system text at 96,000 characters each,
side history at 64,000, questions at 16,000, and answers at 32,000 / 4,096 tokens.
Claude bridge requests retain the complete system prompt so the provider can
recognize its captured parent prompt and project it into Claude Code's preset.
They use short cache retention: bridge 0.9.2 interprets `none` as a summarizer
request and forwards the system prompt verbatim instead of projecting it.
Other providers keep uncached requests and the system-text cap. The bridge's
normal path needs a main-agent prompt capture since the last prompt change;
extensions that change the prompt before the bridge captures it can prevent
matching. It loads Claude Code user/project settings, so configured hooks run
for each BTW request, and it may retain Claude Code transcripts on disk. Closing
BTW discards local overlay state, not provider-managed storage.
The current system prompt excludes later context/payload mutations by other
extensions, as documented by Pi; it is a snapshot, not a second agent turn.

The installed Pi 0.85.1 documentation includes `retainedTail` compaction
checkpoints, while the npm SDK tagged 0.85.1 still implements legacy
`firstKeptEntryId` compactions. BTW explicitly handles the newer checkpoint field
and otherwise uses exported `buildSessionContext`. Regression tests cover both
formats. This compatibility path can disappear when the published SDK catches up.

Tests exercise registered tools/commands, actual dialog keyboard input, lifecycle
shutdown, and the public provider/auth boundary. They use synthetic provider
streams and no credentials. Live provider transport, actual terminal rendering,
and macOS desktop behavior remain separate manual verification surfaces.
