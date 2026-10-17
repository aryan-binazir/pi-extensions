// Ported from openai/codex codex-rs/execpolicy/src/{decision,rule,policy,parser}.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// Codex evaluates `.rules` files with Starlark. This port parses the call-only subset those files use.
import { basename, isAbsolute } from 'node:path';
import { renderShlexCommand, shlexSplit } from './shlex.ts';

export type Decision = 'allow' | 'prompt' | 'forbidden';
const SEVERITY: Record<Decision, number> = { allow: 0, prompt: 1, forbidden: 2 };
const DECISIONS = new Set<string>(Object.keys(SEVERITY));

/** One rule; `rest` holds the alternatives accepted for each token after the first. */
export interface PrefixRule {
  first: string;
  rest: string[][];
  decision: Decision;
  justification: string | undefined;
}

export type RuleMatch =
  | { type: 'prefix'; matchedPrefix: string[]; decision: Decision; resolvedProgram?: string; justification?: string }
  | { type: 'heuristics'; command: string[]; decision: Decision };

export interface Evaluation {
  decision: Decision;
  matchedRules: RuleMatch[];
}

export interface MatchOptions {
  resolveHostExecutables?: boolean;
}

export type HeuristicsFallback = (command: string[]) => Decision;

export class RulesError extends Error {}

export function parseDecision(raw: string): Decision {
  if (!DECISIONS.has(raw)) throw new RulesError(`invalid decision: ${raw}`);
  return raw as Decision;
}

export function strictestDecision(decisions: Iterable<Decision>): Decision | undefined {
  let strictest: Decision | undefined;
  for (const decision of decisions) if (!strictest || SEVERITY[decision] > SEVERITY[strictest]) strictest = decision;
  return strictest;
}

function matchesPrefix(rule: PrefixRule, command: readonly string[]): string[] | undefined {
  const length = rule.rest.length + 1;
  if (command.length < length || command[0] !== rule.first) return undefined;
  for (let index = 0; index < rule.rest.length; index++) {
    if (!rule.rest[index].includes(command[index + 1])) return undefined;
  }
  return command.slice(0, length);
}

function prefixMatch(rule: PrefixRule, matchedPrefix: string[], resolvedProgram?: string): RuleMatch {
  return {
    type: 'prefix', matchedPrefix, decision: rule.decision,
    ...(resolvedProgram === undefined ? {} : { resolvedProgram }),
    ...(rule.justification === undefined ? {} : { justification: rule.justification }),
  };
}

export class Policy {
  private readonly rulesByProgram = new Map<string, PrefixRule[]>();
  readonly hostExecutables = new Map<string, string[]>();

  static empty(): Policy {
    return new Policy();
  }

  clone(): Policy {
    const copy = new Policy();
    for (const [program, rules] of this.rulesByProgram) copy.rulesByProgram.set(program, [...rules]);
    for (const [name, paths] of this.hostExecutables) copy.hostExecutables.set(name, [...paths]);
    return copy;
  }

  rulesFor(program: string): PrefixRule[] {
    return [...(this.rulesByProgram.get(program) ?? [])];
  }

  addRule(rule: PrefixRule): void {
    const rules = this.rulesByProgram.get(rule.first) ?? [];
    rules.push(rule);
    this.rulesByProgram.set(rule.first, rules);
  }

  addPrefixRule(prefix: readonly string[], decision: Decision): void {
    const [first, ...rest] = prefix;
    if (first === undefined) throw new RulesError('invalid pattern element: prefix cannot be empty');
    this.addRule({ first, rest: rest.map(token => [token]), decision, justification: undefined });
  }

  /** Every allow rule as a display prefix, sorted and deduplicated like Codex. */
  allowedPrefixes(): string[][] {
    const prefixes: string[][] = [];
    for (const rules of this.rulesByProgram.values()) {
      for (const rule of rules) {
        if (rule.decision !== 'allow') continue;
        prefixes.push([rule.first, ...rule.rest.map(token => token.length === 1 ? token[0] : `[${token.join('|')}]`)]);
      }
    }
    const compare = (left: string[], right: string[]) => {
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
      }
      return left.length - right.length;
    };
    prefixes.sort(compare);
    return prefixes.filter((prefix, index) => index === 0 || compare(prefix, prefixes[index - 1]) !== 0);
  }

  check(command: string[], fallback: HeuristicsFallback, options: MatchOptions = {}): Evaluation {
    return evaluationFrom(this.matchesForCommand(command, fallback, options));
  }

  checkMultiple(commands: Iterable<string[]>, fallback: HeuristicsFallback, options: MatchOptions = {}): Evaluation {
    const matched: RuleMatch[] = [];
    for (const command of commands) matched.push(...this.matchesForCommand(command, fallback, options));
    return evaluationFrom(matched);
  }

  /** Rule matches, or a single heuristics match when no rule applies and a fallback is supplied. */
  matchesForCommand(command: string[], fallback?: HeuristicsFallback, options: MatchOptions = {}): RuleMatch[] {
    let matched = this.matchExactRules(command);
    if (!matched.length && options.resolveHostExecutables) matched = this.matchHostExecutableRules(command);
    if (!matched.length && fallback) return [{ type: 'heuristics', command: [...command], decision: fallback(command) }];
    return matched;
  }

  private matchExactRules(command: readonly string[]): RuleMatch[] {
    const first = command[0];
    if (first === undefined) return [];
    return (this.rulesByProgram.get(first) ?? []).flatMap(rule => {
      const matched = matchesPrefix(rule, command);
      return matched ? [prefixMatch(rule, matched)] : [];
    });
  }

  private matchHostExecutableRules(command: readonly string[]): RuleMatch[] {
    const program = command[0];
    if (program === undefined || !isAbsolute(program)) return [];
    const name = basename(program);
    const rules = this.rulesByProgram.get(name);
    if (!name || !rules) return [];
    const allowed = this.hostExecutables.get(name);
    if (allowed && !allowed.includes(program)) return [];
    const renamed = [name, ...command.slice(1)];
    return rules.flatMap(rule => {
      const matched = matchesPrefix(rule, renamed);
      return matched ? [prefixMatch(rule, matched, program)] : [];
    });
  }
}

function evaluationFrom(matchedRules: RuleMatch[]): Evaluation {
  const decision = strictestDecision(matchedRules.map(rule => rule.decision));
  if (!decision) throw new Error('invariant failed: matched rules must be non-empty');
  return { decision, matchedRules };
}

type Value = { kind: 'string'; value: string } | { kind: 'list'; items: Value[] };
type Token =
  | { kind: 'name' | 'string'; value: string; offset: number }
  | { kind: 'punct'; value: string; offset: number };

class Source {
  private readonly tokens: Token[];
  private position = 0;

  constructor(private readonly file: string, private readonly text: string) {
    this.tokens = this.tokenize();
  }

  error(message: string, offset = this.peek()?.offset ?? this.text.length): RulesError {
    const before = this.text.slice(0, offset).split('\n');
    return new RulesError(`starlark error: ${this.file}:${before.length}:${before[before.length - 1].length + 1}: ${message}`);
  }

  peek(): Token | undefined {
    return this.tokens[this.position];
  }

  next(): Token {
    const token = this.tokens[this.position++];
    if (!token) throw this.error('unexpected end of file', this.text.length);
    return token;
  }

  expect(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw this.error(`expected \`${value}\``, token.offset);
  }

  accept(value: string): boolean {
    const token = this.peek();
    if (token?.kind !== 'punct' || token.value !== value) return false;
    this.position++;
    return true;
  }

  private tokenize(): Token[] {
    const tokens: Token[] = [];
    const text = this.text;
    for (let i = 0; i < text.length;) {
      const char = text[i];
      if (/\s/.test(char)) { i++; continue; }
      if (char === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if ('()[],=;'.includes(char)) { tokens.push({ kind: 'punct', value: char, offset: i }); i++; continue; }
      const raw = (char === 'r' || char === 'R') && (text[i + 1] === '"' || text[i + 1] === "'");
      if (raw || char === '"' || char === "'") {
        const start = i;
        if (raw) i++;
        const quote = text[i];
        const triple = text.startsWith(quote.repeat(3), i);
        const delimiter = triple ? quote.repeat(3) : quote;
        i += delimiter.length;
        let value = '';
        for (;;) {
          if (i >= text.length || (!triple && text[i] === '\n')) throw this.error('unterminated string literal', start);
          if (text.startsWith(delimiter, i)) { i += delimiter.length; break; }
          if (text[i] === '\\' && !raw) {
            const escaped = this.escape(i);
            value += escaped.value;
            i += escaped.length;
            continue;
          }
          value += text[i++];
        }
        tokens.push({ kind: 'string', value, offset: start });
        continue;
      }
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (name) { tokens.push({ kind: 'name', value: name[0], offset: i }); i += name[0].length; continue; }
      throw this.error(`unexpected character \`${char}\``, i);
    }
    return tokens;
  }

  /** Starlark string escapes, including the `\uXXXX` and control escapes JSON.stringify emits. */
  private escape(offset: number): { value: string; length: number } {
    const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '' };
    const escape = this.text[offset + 1];
    if (escape !== undefined && escape in simple) return { value: simple[escape], length: 2 };
    const octal = /^[0-7]{1,3}/.exec(this.text.slice(offset + 1, offset + 4));
    if (octal) return { value: String.fromCodePoint(Number.parseInt(octal[0], 8)), length: 1 + octal[0].length };
    const digits = { x: 2, u: 4, U: 8 }[escape as 'x' | 'u' | 'U'];
    const hex = digits && this.text.slice(offset + 2, offset + 2 + digits);
    if (hex && hex.length === digits && /^[0-9A-Fa-f]+$/.test(hex)) {
      const code = Number.parseInt(hex, 16);
      if (code <= 0x10ffff && (escape === 'x' || code < 0xd800 || code > 0xdfff)) return { value: String.fromCodePoint(code), length: 2 + digits };
    }
    throw this.error(`invalid escape sequence \\${escape ?? ''}`, offset);
  }
}

type Call = { name: string; offset: number; positional: Value[]; keyword: Map<string, Value> };

function parseValue(source: Source): Value {
  const token = source.next();
  if (token.kind === 'string') return { kind: 'string', value: token.value };
  if (token.kind === 'punct' && token.value === '[') {
    const items: Value[] = [];
    while (!source.accept(']')) {
      items.push(parseValue(source));
      if (!source.accept(',')) { source.expect(']'); break; }
    }
    return { kind: 'list', items };
  }
  throw source.error('expected a string or list literal', token.offset);
}

function parseCalls(source: Source): Call[] {
  const calls: Call[] = [];
  while (source.peek()) {
    if (source.accept(';')) continue;
    const name = source.next();
    if (name.kind !== 'name') throw source.error('expected a function call', name.offset);
    source.expect('(');
    const call: Call = { name: name.value, offset: name.offset, positional: [], keyword: new Map() };
    while (!source.accept(')')) {
      const token = source.peek();
      if (token?.kind === 'name') {
        source.next();
        source.expect('=');
        if (call.keyword.has(token.value)) throw source.error(`duplicate argument \`${token.value}\``, token.offset);
        call.keyword.set(token.value, parseValue(source));
      } else {
        if (call.keyword.size) throw source.error('positional argument follows keyword argument', token?.offset);
        call.positional.push(parseValue(source));
      }
      if (!source.accept(',')) { source.expect(')'); break; }
    }
    calls.push(call);
  }
  return calls;
}

function bindArguments(source: Source, call: Call, parameters: string[], required: string[]): Map<string, Value> {
  const bound = new Map<string, Value>();
  if (call.positional.length > parameters.length) throw source.error(`too many positional arguments to \`${call.name}\``, call.offset);
  call.positional.forEach((value, index) => bound.set(parameters[index], value));
  for (const [name, value] of call.keyword) {
    if (!parameters.includes(name)) throw source.error(`unexpected argument \`${name}\` to \`${call.name}\``, call.offset);
    if (bound.has(name)) throw source.error(`argument \`${name}\` given twice`, call.offset);
    bound.set(name, value);
  }
  for (const name of required) if (!bound.has(name)) throw source.error(`missing argument \`${name}\` to \`${call.name}\``, call.offset);
  return bound;
}

function stringValue(value: Value | undefined, describe: (type: string) => string): string | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== 'string') throw new RulesError(describe('list'));
  return value.value;
}

function listValue(value: Value, describe: (type: string) => string): Value[] {
  if (value.kind !== 'list') throw new RulesError(describe('string'));
  return value.items;
}

function parsePatternToken(value: Value): string[] {
  if (value.kind === 'string') return [value.value];
  const alternatives = value.items.map(item => {
    if (item.kind !== 'string') throw new RulesError('invalid pattern element: pattern alternative must be a string (got list)');
    return item.value;
  });
  if (!alternatives.length) throw new RulesError('invalid pattern element: pattern alternatives cannot be empty');
  return alternatives;
}

function parseExample(value: Value): string[] {
  if (value.kind === 'string') {
    const tokens = shlexSplit(value.value);
    if (!tokens) throw new RulesError('invalid example: example string has invalid shell syntax');
    if (!tokens.length) throw new RulesError('invalid example: example cannot be an empty string');
    return tokens;
  }
  const tokens = value.items.map(item => {
    if (item.kind !== 'string') throw new RulesError('invalid example: example tokens must be strings (got list)');
    return item.value;
  });
  if (!tokens.length) throw new RulesError('invalid example: example cannot be an empty list');
  return tokens;
}

function justificationValue(value: Value | undefined): string | undefined {
  const justification = stringValue(value, type => `invalid rule: justification must be a string (got ${type})`);
  if (justification !== undefined && !justification.trim()) throw new RulesError('invalid rule: justification cannot be empty');
  return justification;
}

function describeRule(rule: PrefixRule): string {
  return `PrefixRule { pattern: ${JSON.stringify([rule.first, ...rule.rest])}, decision: ${rule.decision} }`;
}

interface PendingValidation {
  rules: PrefixRule[];
  matches: string[][];
  notMatches: string[][];
}

/** Accumulates rules across files; later files extend earlier ones and later host executables win. */
export class PolicyParser {
  private readonly policy = new Policy();

  parse(file: string, text: string): void {
    const source = new Source(file, text);
    const pending: PendingValidation[] = [];
    for (const call of parseCalls(source)) {
      try {
        if (call.name === 'prefix_rule') pending.push(this.prefixRule(source, call));
        else if (call.name === 'host_executable') this.hostExecutable(source, call);
        else if (call.name === 'network_rule') bindArguments(source, call, ['host', 'protocol', 'decision', 'justification'], ['host', 'protocol', 'decision']);
        else throw source.error(`Variable \`${call.name}\` not found`, call.offset);
      } catch (error) {
        if (error instanceof RulesError && !error.message.startsWith('starlark error:')) throw source.error(error.message, call.offset);
        throw error;
      }
    }
    for (const validation of pending) this.validateExamples(validation);
  }

  build(): Policy {
    return this.policy;
  }

  private prefixRule(source: Source, call: Call): PendingValidation {
    const args = bindArguments(source, call, ['pattern', 'decision', 'match', 'not_match', 'justification'], ['pattern']);
    const decisionRaw = stringValue(args.get('decision'), type => `invalid decision: expected a string (got ${type})`);
    const decision = decisionRaw === undefined ? 'allow' : parseDecision(decisionRaw);
    const justification = justificationValue(args.get('justification'));
    const tokens = listValue(args.get('pattern')!, type => `invalid pattern element: pattern must be a list (got ${type})`).map(parsePatternToken);
    if (!tokens.length) throw new RulesError('invalid pattern element: pattern cannot be empty');
    const examples = (name: string) => {
      const value = args.get(name);
      return value ? listValue(value, type => `invalid example: ${name} must be a list (got ${type})`).map(parseExample) : [];
    };
    const matches = examples('match'), notMatches = examples('not_match');
    const [first, ...rest] = tokens;
    const rules = first.map(head => ({ first: head, rest, decision, justification }));
    for (const rule of rules) this.policy.addRule(rule);
    return { rules, matches, notMatches };
  }

  private hostExecutable(source: Source, call: Call): void {
    const args = bindArguments(source, call, ['name', 'paths'], ['name', 'paths']);
    const name = stringValue(args.get('name'), type => `invalid rule: host_executable name must be a string (got ${type})`)!;
    if (!name) throw new RulesError('invalid rule: host_executable name cannot be empty');
    if (name.includes('/') || name === '.' || name === '..') throw new RulesError(`invalid rule: host_executable name must be a bare executable name (got ${name})`);
    const paths: string[] = [];
    for (const value of listValue(args.get('paths')!, type => `invalid rule: host_executable paths must be a list (got ${type})`)) {
      if (value.kind !== 'string') throw new RulesError('invalid rule: host_executable paths must be strings (got list)');
      const path = value.value;
      if (!isAbsolute(path)) throw new RulesError(`invalid rule: host_executable paths must be absolute (got ${path})`);
      if (basename(path) !== name) throw new RulesError(`invalid rule: host_executable path \`${path}\` must have basename \`${name}\``);
      if (!paths.includes(path)) paths.push(path);
    }
    this.policy.hostExecutables.set(name, paths);
  }

  private validateExamples({ rules, matches, notMatches }: PendingValidation): void {
    const scoped = new Policy();
    for (const rule of rules) scoped.addRule(rule);
    for (const [name, paths] of this.policy.hostExecutables) scoped.hostExecutables.set(name, paths);
    const options = { resolveHostExecutables: true };
    for (const example of notMatches) {
      const [matched] = scoped.matchesForCommand(example, undefined, options);
      if (matched) throw new RulesError(`expected example to not match rule \`${describeRule(rules[0])}\`: ${renderShlexCommand(example)}`);
    }
    const unmatched = matches.filter(example => !scoped.matchesForCommand(example, undefined, options).length);
    if (unmatched.length) {
      throw new RulesError(`expected every example to match at least one rule. rules: ${JSON.stringify(rules.map(describeRule))}; unmatched examples: ${JSON.stringify(unmatched.map(example => renderShlexCommand(example)))}`);
    }
  }
}
