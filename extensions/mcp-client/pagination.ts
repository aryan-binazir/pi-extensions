/** Harbor MCP bounded catalog collection; see docs/adr/007-harbor-mcp.md. */
export class McpLimitError extends Error {}

export async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 32; page++) {
    const result = await fetchPage(cursor);
    if (items.length + result.items.length > 256) throw new McpLimitError('MCP catalog exceeds 256 items');
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    if (Buffer.byteLength(result.nextCursor) > 65536) throw new McpLimitError('MCP pagination cursor exceeds 64 KiB');
    if (seen.has(result.nextCursor)) throw new McpLimitError('MCP server returned a repeated pagination cursor');
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new McpLimitError('MCP catalog exceeds 32 pages');
}

/** One wall-clock budget for an entire operation, including all catalog pages. */
export async function withDeadline<T>(
  timeoutMs: number,
  signals: (AbortSignal | undefined)[],
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('MCP request timed out', 'TimeoutError')), timeoutMs);
  const signal = AbortSignal.any([deadline.signal, ...signals.filter((s): s is AbortSignal => s !== undefined)]);
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([aborted, run(signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
