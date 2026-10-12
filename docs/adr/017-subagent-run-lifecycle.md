# ADR 017: Subagent run lifecycle

Status: accepted

[ADR 008](008-subagents-workflows.md) defines supervised children and approved
workflows. [ADR 015](015-delegation-admission.md) owns permission admission.
The extension previously reconstructed cancellation causes from task IDs and
coordinated workflow aborts, completion batches and tracker activity with closure
flags. The registry now owns that lifecycle.

`SubagentRegistry` tracks children through `spawn` and abortable workflow runs
through `track`. `cancelAll` snapshots both, cancels children before aborting
workflows, awaits their cleanup, and returns the tool's existing `{cancelled,
count}` result. The count includes children once; an active workflow makes
`cancelled` true even without children. Shutdown closes the registry, discards
pending notices, aborts workflows and awaits cleanup. Session restart creates a
new registry. Admission and workflow journal policy remain unchanged.

Child results record the first cancellation cause: user, cancel-all, timeout,
shutdown, the existing repeated-failure stall guard, or a workflow-runner abort.
Workflow-runner aborts do not distinguish its deadline from failure cleanup;
that distinction is not available in its signal. Workflow deadlines remain in
the workflow runner, and returned values, error strings and abort reasons stay
unchanged. Cause metadata
is internal to the registry contract; `taskView` keeps parent messages and status
unchanged. Successful results, including serialized workflow journal records,
retain their original shape.

The injected notification sink receives serialized content and delivery options.
Only parent-owned children notify. Cancel-all suppresses results it actually
cancels and preserves previously batched notices, including overflow. Children
admitted during the cleanup wait remain eligible. Shutdown suppresses every
completion. Any eligible non-cancelled status requests a parent turn, including a
completion beyond the notice limit; ordinary cancellation uses `nextTurn`.

The first eligible completion opens a fixed 250 ms window. At most 16 detailed
notices are retained. A single notice keeps its 4096-byte output view; batches
re-clip output to 1024 bytes and admit compact notices into a 12000-byte JSON
array. Notices that do not fit and notices beyond the count limit contribute to
`additionalCompletions`. Sink failures are recorded on retained tasks.

Activity signals carry tracker intent and child background intervals. The
extension adapts those signals to the existing tracker and panel. Streaming and
completion repaint timing, tracker cancellation gates, and background interval
ordering stay intact. Even a synchronous launch failure emits active before
inactive. Overlapping cancel-all calls retain the existing boolean tracker gate;
changing that behavior requires a separate fix.

The invocation port accepts either a launch command or an already-created child
process launched with the same detached process-group ownership as the command
invocation. Production still uses the existing supervised invocation. In-process
fixtures supply event emitters and streams through that same port, exercising
real result parsing and cleanup without starting subprocesses. Fake timers and
an in-memory sink cover cancellation races and batching. Host tests retain
approval, workflow child counts, session restart, tracker/panel wiring, sink
failure handling and process supervision.
