// Ported from the shlex crate 1.3.0 (MIT OR Apache-2.0, (c) 2015 Nicholas Allegra), the version openai/codex @ ce0323f
// uses; see docs/licenses/README.md.

const WHITESPACE = new Set([' ', '\t', '\n']);

/** POSIX-style word splitting without expansion; undefined on unbalanced quotes or a trailing escape. */
export function shlexSplit(input: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  const next = () => (i < input.length ? input[i++] : undefined);
  for (let char = next(); char !== undefined; char = next()) {
    if (WHITESPACE.has(char)) continue;
    if (char === '#') {
      for (let skipped = next(); skipped !== undefined && skipped !== '\n'; skipped = next());
      continue;
    }
    let word = '';
    for (let current: string | undefined = char; current !== undefined && !WHITESPACE.has(current); current = next()) {
      if (current === '"') {
        for (;;) {
          const quoted = next();
          if (quoted === undefined) return undefined;
          if (quoted === '"') break;
          if (quoted !== '\\') { word += quoted; continue; }
          const escaped = next();
          if (escaped === undefined) return undefined;
          if ('$`"\\'.includes(escaped)) word += escaped;
          else if (escaped !== '\n') word += `\\${escaped}`;
        }
      } else if (current === "'") {
        for (;;) {
          const quoted = next();
          if (quoted === undefined) return undefined;
          if (quoted === "'") break;
          word += quoted;
        }
      } else if (current === '\\') {
        const escaped = next();
        if (escaped === undefined) return undefined;
        if (escaped !== '\n') word += escaped;
      } else {
        word += current;
      }
    }
    words.push(word);
  }
  return words;
}

const UNQUOTED = 1, SINGLE_QUOTED = 2, DOUBLE_QUOTED = 4;
const UNQUOTED_OK = /[+\-./:@\]_0-9A-Za-z]/;

function allowedStrategies(char: string): number {
  if (char.codePointAt(0)! >= 0x80) return SINGLE_QUOTED | DOUBLE_QUOTED;
  let ok = 0;
  if (UNQUOTED_OK.test(char)) ok |= UNQUOTED;
  // Bash mishandles ^ after anything but an opening single quote; Fish treats backslashes in single quotes as escapes.
  if (char !== "'" && char !== '^' && char !== '\\') ok |= SINGLE_QUOTED;
  if (!'`$!^'.includes(char)) ok |= DOUBLE_QUOTED;
  return ok;
}

/** The longest prefix one strategy can quote, and the best such strategy. */
function quotingStrategy(input: string): [length: number, strategy: number] {
  let previous = UNQUOTED | SINGLE_QUOTED | DOUBLE_QUOTED;
  let i = 0;
  if (input[0] === '^') { previous = SINGLE_QUOTED; i = 1; }
  for (; i < input.length; i++) {
    const current = previous & allowedStrategies(input[i]);
    if (!current) break;
    previous = current;
  }
  const strategy = previous & UNQUOTED ? UNQUOTED : previous & SINGLE_QUOTED ? SINGLE_QUOTED : DOUBLE_QUOTED;
  return [i, strategy];
}

/** Quotes one word for a POSIX shell; undefined when it contains a nul byte. */
export function shlexTryQuote(word: string): string | undefined {
  if (!word) return "''";
  if (word.includes('\0')) return undefined;
  let out = '';
  for (let rest = word; rest;) {
    const [length, strategy] = quotingStrategy(rest);
    const chunk = rest.slice(0, length);
    rest = rest.slice(length);
    if (strategy === UNQUOTED) out += chunk;
    else if (strategy === SINGLE_QUOTED) out += `'${chunk}'`;
    else out += `"${chunk.replace(/[$`"\\]/g, '\\$&')}"`;
  }
  return out;
}

export function shlexTryJoin(words: readonly string[]): string | undefined {
  const quoted: string[] = [];
  for (const word of words) {
    const part = shlexTryQuote(word);
    if (part === undefined) return undefined;
    quoted.push(part);
  }
  return quoted.join(' ');
}

/** Codex's `render_shlex_command`: quoted when possible, otherwise space-joined. */
export function renderShlexCommand(words: readonly string[]): string {
  return shlexTryJoin(words) ?? words.join(' ');
}
