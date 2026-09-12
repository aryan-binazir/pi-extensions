import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface SentinelConfig {
  classifier: string;
  reviewer: string;
  policyFile: string;
  maxToolCallLag: number;
  timeoutMs: number;
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Bound reads before allocation. Refuse symlinks, devices, FIFOs, and invalid UTF-8. */
export async function readBounded(path: string, maxBytes: number, optional = false): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`Sentinel file must be a regular file of at most ${maxBytes} bytes: ${path}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > maxBytes) throw new Error(`Sentinel file exceeds limit: ${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
  } finally { await file.close(); }
}

export async function loadConfig(agentDir: string): Promise<SentinelConfig> {
  const text = await readBounded(join(agentDir, 'sentinel.json'), 8192, true);
  const value: unknown = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sentinel.json must be an object');
  const raw = value as Record<string, unknown>;
  const allowed = ['classifier', 'reviewer', 'policyFile', 'maxToolCallLag', 'timeoutMs'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error(`Unknown Sentinel setting: ${key}`);
  const model = (key: string, fallback: string): string => {
    const result = raw[key] ?? fallback;
    if (typeof result !== 'string' || !/^[\w.-]+\/[\w./:-]+$/.test(result)) throw new Error(`Sentinel ${key} must be provider/model`);
    return result;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const result = raw[key] ?? fallback;
    if (typeof result !== 'number' || !Number.isInteger(result) || result < min || result > max) throw new Error(`Sentinel ${key} must be ${min}–${max}`);
    return result;
  };
  const policyFile = raw.policyFile ?? join(agentDir, 'sentinel-policy.md');
  if (typeof policyFile !== 'string' || !isAbsolute(policyFile)) throw new Error('Sentinel policyFile must be absolute');
  return {
    classifier: model('classifier', 'openai-codex/gpt-5.6-luna'),
    reviewer: model('reviewer', 'openai-codex/codex-auto-review'),
    policyFile: resolve(policyFile),
    maxToolCallLag: integer('maxToolCallLag', 2, 0, 2),
    timeoutMs: integer('timeoutMs', 60000, 100, 300000),
  };
}

export async function loadPreferences(config: SentinelConfig, agentDir: string): Promise<string> {
  // Only the default absent file means no preferences; an explicitly selected missing file is an error.
  return readBounded(config.policyFile, 32768, config.policyFile === resolve(agentDir, 'sentinel-policy.md'));
}
