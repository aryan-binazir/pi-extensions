import { readFile, stat } from 'node:fs/promises';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

const isPlainMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** Parses the on/off switches without checking that the hook ids exist. */
export function parseSwitches(text: string): Map<string, boolean> {
  // Pi exports its YAML parser only through frontmatter, so document markers would end the parsed block early.
  if (/^(---|\.\.\.)/m.test(text)) throw new Error('YAML document markers (--- or ...) are not allowed');
  const { frontmatter, body } = parseFrontmatter(`---\n${text}\n---\n`);
  const keys = Object.keys(frontmatter);
  const hooks = (frontmatter as Record<string, unknown>).hooks ?? {};
  if (body || keys.length !== 1 || keys[0] !== 'hooks' || !isPlainMapping(hooks)) {
    throw new Error('Expected a single top-level "hooks" mapping of hook ids to true or false');
  }
  const switches = new Map<string, boolean>();
  for (const [id, on] of Object.entries(hooks)) {
    if (typeof on !== 'boolean') throw new Error(`"${id}" must be true or false`);
    switches.set(id, on);
  }
  return switches;
}

export function enabledIn(switches: Map<string, boolean>): Set<string> {
  return new Set([...switches].filter(([, on]) => on).map(([id]) => id));
}

export function unknownIds(switches: Map<string, boolean>, known: ReadonlySet<string>): string[] {
  return [...switches.keys()].filter(id => !known.has(id));
}

/** Enabled hooks this code knows, and enabled ids it does not, which a newer checkout added. */
export async function loadSwitches(path: string, known: ReadonlySet<string>, read?: () => Promise<SwitchesFile>): Promise<{ enabled: Set<string>; unloaded: string[] }> {
  const enabled = enabledIn(read ? (await read()).switches : parseSwitches(await readFile(path, 'utf8')));
  return { enabled: new Set([...enabled].filter(id => known.has(id))), unloaded: [...enabled].filter(id => !known.has(id)) };
}

export interface SwitchesFile {
  text: string;
  switches: Map<string, boolean>;
}

export function createSwitchesReader(path: string): () => Promise<SwitchesFile> {
  let cached: { key: string; file: SwitchesFile } | undefined;
  return async () => {
    const info = await stat(path, { bigint: true });
    const key = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    if (cached?.key === key) return cached.file;
    const text = await readFile(path, 'utf8');
    let switches: Map<string, boolean> | undefined;
    const file = { text, get switches() { return switches ??= parseSwitches(text); } };
    cached = { key, file };
    return file;
  };
}
