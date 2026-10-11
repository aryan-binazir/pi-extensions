import { readFile } from 'node:fs/promises';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

/** Parses the on/off switches without checking that the hook ids exist. */
export function parseSwitches(text: string): Map<string, boolean> {
  // Pi exports its YAML parser only through frontmatter, so document markers would end the parsed block early.
  if (/^(---|\.\.\.)/m.test(text)) throw new Error('YAML document markers (--- or ...) are not allowed');
  const { frontmatter, body } = parseFrontmatter(`---\n${text}\n---\n`);
  const keys = Object.keys(frontmatter);
  const hooks = (frontmatter as Record<string, unknown>).hooks ?? {};
  // Tagged YAML collections such as !!omap and !!set parse to Map or Set, whose entries Object.entries cannot see.
  if (body || keys.length !== 1 || keys[0] !== 'hooks' || typeof hooks !== 'object' || Object.getPrototypeOf(hooks) !== Object.prototype) {
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
export async function loadSwitches(path: string, known: ReadonlySet<string>): Promise<{ enabled: Set<string>; unloaded: string[] }> {
  const enabled = enabledIn(parseSwitches(await readFile(path, 'utf8')));
  return { enabled: new Set([...enabled].filter(id => known.has(id))), unloaded: [...enabled].filter(id => !known.has(id)) };
}
