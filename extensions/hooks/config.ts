import { readFile } from 'node:fs/promises';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

/** Parses the on/off switches without checking that the hook ids exist. */
export function parseSwitches(text: string): Map<string, boolean> {
  // Pi exports its YAML parser only through frontmatter, so document markers would end the parsed block early.
  if (/^(---|\.\.\.)/m.test(text)) throw new Error('YAML document markers (--- or ...) are not allowed');
  const { frontmatter, body } = parseFrontmatter(`---\n${text}\n---\n`);
  const hooks = (frontmatter as Record<string, unknown>).hooks;
  if (body || Object.keys(frontmatter).length !== 1 || !hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
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

export async function loadEnabled(path: string, known: ReadonlySet<string>): Promise<Set<string>> {
  const switches = parseSwitches(await readFile(path, 'utf8'));
  const unknown = unknownIds(switches, known);
  if (unknown.length) throw new Error(`Unknown hooks: ${unknown.join(', ')}`);
  return enabledIn(switches);
}
