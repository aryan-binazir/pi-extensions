import type { TaskResult } from './registry.ts';

/** Bound the serialized string, including JSON escaping and multi-byte text. */
export function clipJson(text: string, bytes: number, tail = false): string {
  // Every UTF-16 unit serializes to 1–6 bytes plus the two quotes, so both
  // bounds decide most probes outright. Keeping the probe count and search
  // path identical matters: JSON escaping of lone surrogates is not monotone
  // in the prefix length, so the answer depends on which lengths are visited.
  if (text.length * 6 + 2 <= bytes) return text;
  const take = (length: number) => tail ? text.slice(text.length - length) : text.slice(0, length);
  const overflows = (length: number) => length + 2 > bytes || Buffer.byteLength(JSON.stringify(take(length)), 'utf8') > bytes;
  if (!overflows(text.length)) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (!overflows(middle)) low = middle;
    else high = middle - 1;
  }
  return take(low);
}

export function taskView(task: TaskResult, outputBytes = 512, outputOffset?: number) {
  const source = task.output.slice(outputOffset ?? 0);
  const output = clipJson(source, outputBytes, outputOffset === undefined);
  return {
    id: task.id, owner: task.owner, status: task.status,
    model: task.model && clipJson(task.model, 256), thinking: task.thinking,
    task: clipJson(task.task, 128), cwd: clipJson(task.cwd, 512),
    usage: task.usage, usageIncomplete: task.usageIncomplete,
    output, outputLength: task.output.length, outputTruncated: output.length < source.length,
    nextOutputOffset: outputOffset !== undefined && outputOffset + output.length < task.output.length ? outputOffset + output.length : undefined,
    stderr: clipJson(task.stderr, outputBytes > 512 ? 1024 : 128, true),
    error: task.error && clipJson(task.error, 512),
    notificationError: task.notificationError && clipJson(task.notificationError, 256),
    droppedRecords: task.droppedRecords,
  };
}
