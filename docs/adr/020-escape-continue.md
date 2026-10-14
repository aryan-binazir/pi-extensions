# 020: Escape Continue session seam

Status: accepted.

Escape Continue promotes the first queued user message after stopping the current run. Its cancellation and queue-retention policy previously read Pi activity flags, prompt-preflight results, async-local ownership and prepared-queue internals inside one closure. Changes in Pi's interpretation of those signals caused three regressions in succession.

`adapter.ts` is the sole Pi-facing module. It validates the prepared queue and image-normalization layout, patches the host lifecycle and queue methods, and implements `SessionPort`. Unsupported internals still warn once per session and fall back to normal Escape. The shape probe checks compatibility, not ownership.

`promotion.ts` owns selection, held messages, cancellation, delivery, restoration and release. Its session interface exposes a queue snapshot, clear/restore/capture operations, raw abort, a streaming predicate, and an abort-and-prompt operation with cancellation checkpoints and normalized start/delivery events. It never reads Pi flags, private fields, prompt-preflight dispositions or async-local storage. UI callbacks provide registration identity and notices without exposing the host session.

The adapter keeps these version facts as executable code:

| Pi behavior | Adapter rule | Regression |
| --- | --- | --- |
| A session idle property is absent or unreliable on older hosts. | Foreign activity uses streaming or compaction after abort settles. Context input cancellation retains the separate `ctx.isIdle()` check. | `7229077` |
| Pi 0.87 reports boolean prompt-preflight results; Pi 0.99 reports dispositions such as `started`. | The disposition starts ownership when available. An `agent_start` inside the prompt's async-local scope also starts ownership. | `c5a384b` |
| Pi 1.2 sets streaming before final image preparation. | Image checkpoints check cancellation and registration identity only. Foreign activity is checked once after abort, before starting the promoted prompt. | `8c9859f` |
| Pi 0.99 commits prompt options and next-turn messages after image normalization. | Cancellation is checked before and after that asynchronous boundary, never thrown from the post-commit preflight observer. | Existing cancellation tests |

Preflight start and run start remain distinct events. Preflight only establishes ownership; a run-start event also aborts a cancelled promotion. Once ownership starts, subsequent user-message events mark delivery as before. Restoration excludes the selected message only after delivery. Prepared messages retain attachments and custom contents; stock dequeue remains text-only.

Per-version scripted session adapters test promotion policy through `SessionPort`, including cancellation between preflight start and actual run start. A table of per-version session fakes drives the real AgentSession, faux provider and editor chord through the real Pi adapter. The rows cover 0.87 boolean preflight, 0.99 baseline, a legacy missing idle getter and 1.2 early streaming, plus foreign streaming and compaction after abort. Reverting each historical adapter fact must fail the corresponding row. The key-driven behavioral suite remains the integration contract.

The internal operation is named **promotion**, reserving **handoff** for vi-mode's editor transfer. The status and fallback notice use promotion where they previously literally said handoff. Chord handling and the custom-editor wrapper stay unchanged.

Reloaded extension modules share existing prototype/session wrappers through `Symbol.for` state. The symbol keys, `pending`, its `cancel`, `capture`, `restoreAtContext` and `takeQueue` methods, and shared attach/decorate/interrupt signatures remain compatible with earlier wrappers. Raw abort and checkpoint storage stay in that shared state.

No prompt, queue, input precedence or lifecycle behavior changes are intended. Splitting the editor input pipeline is separate work.
