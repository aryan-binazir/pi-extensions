# ADR 019: Workflow journal ownership

Status: accepted

[ADR 008](008-subagents-workflows.md) defines workflow replay and retention.
`WorkflowJournal` in `extensions/subagents/workflow-journal.ts` owns identity
exclusion, loading, signature lookup, budget reservations, atomic stage writes
and pruning. Moving them out of the workflow runner gives storage policy one
interface that can be exercised with temporary directories, without compiling a
workflow or starting a worker.

`open` takes exclusive in-process ownership before its first await, prunes other
idle journals and loads records in modification-time/key order. Failed loads
release ownership. `lookup` optionally checks a task signature. `record` reserves
a full 1 MiB before invoking a spawn operation and releases it after persistence
or failure. `checkpoint` reserves the complete serialized record size. Both
share the 32 MiB journal budget and serialized write queue. `touch` marks approved
replay use; `close` drains writes and releases ownership. Callers settle their
operations before closing and do not write through a closed journal.

The runner retains the identity payload and task hashes, source/replay approval,
[admission and replay rechecks](015-delegation-admission.md), worker IPC and its
abort controller. Each persistence failure reports synchronously to that
controller before rejecting. The runner settles pending capability calls before
closing the journal. [Registry run ownership](017-subagent-run-lifecycle.md)
remains unchanged.

This extraction preserves version-2 record bytes and field order, SHA256 stage
filenames, directory/file modes, lazy journal-directory creation, limits, error
strings and retryability. The identity set still spans journal directories within
one process. Legacy single-file journals and their temporary files remain
idle-only pruning candidates and consume no retention slots. Tests use `utimes`
with hour/day margins, so no clock adapter is needed.

Existing gaps remain: loading detects growth but not truncation or same-size
rewrites; retention uses directory mtime and protects other processes only through
the idle threshold; subsequent writes wrap an existing persistence error again;
checkpoint reservations do not subtract a replaced record's size, and checkpoint
replay accepts any loaded string signature. These need separate behavior changes.

Module tests cover budget exhaustion and release, stage caps, signature mismatch,
invalid/oversized/non-regular files, symlink rejection, identity exclusion,
retention, replay ordering and persistence failures. One explicit compatibility
test constructs old filenames and pins record bytes, modes, legacy pruning and
the load-total cap. End-to-end workflow tests retain replay approval, permission
rechecks, resumed results, reservation waiting and failure-abort wiring.
