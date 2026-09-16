import { createHash } from 'node:crypto';

// Bounding helpers for untrusted MCP data. Deliberately dependency-free so the
// extension entry point can render output and name tools without loading the
// MCP SDK; client.ts re-exports both for callers that already hold it.

export function toolName(server: string, name: string) {
  const hash = createHash('sha256').update(JSON.stringify([server, name])).digest('hex').slice(0, 16);
  return `mcp_${server.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16)}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}_${hash}`;
}

export function boundedResult(value: unknown, maxBytes = 65536): string {
  let text: string;
  try { text = JSON.stringify(value) ?? 'null'; }
  catch { return '[MCP output omitted: value is too deeply nested or not JSON serializable]'; }
  // UTF-8 length is between text.length and 3 * text.length, so both outcomes are
  // often decidable without scanning the whole string.
  if (text.length <= maxBytes && (text.length * 3 <= maxBytes || Buffer.byteLength(text) <= maxBytes)) return text;
  const keep = maxBytes - 64;
  // UTF-8 encodes character by character, so the first `keep` bytes of the whole
  // string are the first `keep` bytes of its first `keep` characters. Slicing
  // first keeps the temporary buffer bounded instead of copying the full value.
  return Buffer.from(text.slice(0, keep)).subarray(0, keep).toString('utf8') + '\n[MCP output truncated]';
}
