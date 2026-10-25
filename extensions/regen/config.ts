import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-ai';

export type RegenConfig = { model: string; thinking: ThinkingLevel | 'off' };
export const DEFAULT_CONFIG: RegenConfig = { model: 'openai-codex/gpt-6-luna', thinking: 'low' };
export const MAX_CONFIG_BYTES = 4096;
const efforts = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function parseConfig(value: unknown): RegenConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'model' && key !== 'thinking') throw new Error(`unknown config field: ${key}`);
  if ('model' in record && (typeof record.model !== 'string' || !/^[^/\s\p{C}]+\/[^\s\p{C}]+$/u.test(record.model))) throw new Error('model must be provider/model');
  if ('thinking' in record && (typeof record.thinking !== 'string' || !efforts.has(record.thinking))) throw new Error('thinking must be off, minimal, low, medium, high, or xhigh');
  return { ...DEFAULT_CONFIG, ...record } as RegenConfig;
}

export async function readConfig(cwd: string, trusted: boolean): Promise<RegenConfig> {
  if (!trusted) return { ...DEFAULT_CONFIG };
  const file = await open(join(cwd, '.pi', 'regen.json'), constants.O_RDONLY | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('cannot read .pi/regen.json');
  });
  if (!file) return { ...DEFAULT_CONFIG };
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('.pi/regen.json must be a regular file');
    if (stat.size > MAX_CONFIG_BYTES) throw new Error('.pi/regen.json exceeds 4096 bytes');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error('.pi/regen.json exceeds 4096 bytes');
    let value: unknown;
    try { value = JSON.parse(buffer.toString('utf8', 0, bytesRead)); }
    catch { throw new Error('.pi/regen.json must be valid JSON'); }
    return parseConfig(value);
  } finally { await file.close(); }
}
