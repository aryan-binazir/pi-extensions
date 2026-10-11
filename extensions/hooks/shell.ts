// $'...' escapes outside this map become NUL, which no Bash argument can contain, so hooks can refuse what they cannot decode.
const ansiEscapes: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

function commands(source: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [], word = '', quote = '', started = false;
  const flushWord = () => { if (started) words.push(word); word = ''; started = false; };
  const flushCommand = () => { flushWord(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (quote === '$') {
      if (char === "'") quote = ''; else if (char !== '\\') word += char; else { word += ansiEscapes[next] ?? '\0'; i++; }
      continue;
    }
    if (char === '\\' && quote !== "'" && next !== undefined) {
      if (next === '\n') { i++; continue; }
      if (!quote || ['$', '`', '"', '\\'].includes(next)) { word += next; started = true; i++; continue; }
    }
    if (quote) {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '$' && next === '$') { // $$ is the PID, so its second $ never opens $'...'.
      word += '$$'; started = true; i++;
    } else if (char === '$' && (next === "'" || next === '"')) {
      quote = next === '"' ? next : '$'; started = true; i++;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (char === '#' && !started) {
      while (i < source.length && source[i] !== '\n') i++;
      flushCommand();
    } else if (';|&\n'.includes(char)) {
      flushCommand();
    } else if (char === ' ' || char === '\t') {
      flushWord();
    } else {
      word += char; started = true;
    }
  }
  flushCommand();
  return result;
}

export interface Invocation {
  assignments: string[];
  name: string;
  args: string[];
}

/** Simple Bash commands as unquoted words, with leading VAR=value assignments split off. Expansion, substitution and redirection are not interpreted. */
export function invocations(source: string): Invocation[] {
  return commands(source).map(words => {
    let start = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? '')) start++;
    return { assignments: words.slice(0, start), name: words[start] ?? '', args: words.slice(start + 1) };
  });
}
