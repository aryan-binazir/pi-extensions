// Ported from openai/codex codex-rs/shell-command/src/{bash,shell_detect,command_safety/is_dangerous_command}.rs @ ce0323f (Apache-2.0);
// see docs/licenses/README.md. Uses the same tree-sitter-bash grammar version Codex pins, via WebAssembly.
import { createRequire } from 'node:module';
import { Language, type Node, Parser } from 'web-tree-sitter';

export type DangerousCommandMatch = 'forced_rm' | 'other';
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

const ALLOWED_KINDS = new Set(['program', 'list', 'pipeline', 'command', 'command_name', 'word', 'string', 'string_content', 'raw_string', 'number', 'concatenation']);
const ALLOWED_PUNCT_TOKENS = new Set(['&&', '||', ';', '|', '"', "'"]);
const EXPANDING_WORD_CHARS = /[{}*?[\]\\~^#$`]/;

function isLiteralWordOrNumber(node: Node): boolean {
  if (node.type !== 'word' && node.type !== 'number') return false;
  // A tree-sitter word can still undergo shell expansion or escape removal, including Zsh's
  // equals expansion and extended globs; its source spelling is not proof of runtime argv.
  return node.namedChildCount === 0 && !node.text.startsWith('=') && !EXPANDING_WORD_CHARS.test(node.text);
}

function parseDoubleQuotedString(node: Node): string | undefined {
  if (node.type !== 'string' || node.namedChildren.some(part => part?.type !== 'string_content')) return undefined;
  const raw = node.text;
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  const stripped = raw.slice(1, -1);
  // Double quotes suppress globbing and brace expansion, but not escape removal.
  return /\\[$`"\\\n]/.test(stripped) ? undefined : stripped;
}

function parseRawString(node: Node): string | undefined {
  if (node.type !== 'raw_string') return undefined;
  const raw = node.text;
  return raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : undefined;
}

function parsePlainCommandFromNode(command: Node): string[] | undefined {
  if (command.type !== 'command') return undefined;
  const words: string[] = [];
  for (const child of command.namedChildren) {
    if (!child) return undefined;
    switch (child.type) {
      case 'command_name': {
        const word = child.namedChild(0);
        if (word?.type !== 'word') return undefined;
        words.push(word.text);
        break;
      }
      case 'word': case 'number': words.push(child.text); break;
      case 'string': case 'raw_string': {
        const parsed = child.type === 'string' ? parseDoubleQuotedString(child) : parseRawString(child);
        if (parsed === undefined) return undefined;
        words.push(parsed);
        break;
      }
      case 'concatenation': {
        let concatenated = '';
        for (const part of child.namedChildren) {
          if (!part) return undefined;
          const parsed = part.type === 'word' || part.type === 'number' ? part.text
            : part.type === 'string' ? parseDoubleQuotedString(part)
              : part.type === 'raw_string' ? parseRawString(part) : undefined;
          if (parsed === undefined) return undefined;
          concatenated += parsed;
        }
        if (!concatenated) return undefined;
        words.push(concatenated);
        break;
      }
      default: return undefined;
    }
  }
  return words;
}

function parseLiteralShellWord(node: Node): string | undefined {
  switch (node.type) {
    case 'word': case 'number': return isLiteralWordOrNumber(node) ? node.text : undefined;
    case 'string': return parseDoubleQuotedString(node);
    case 'raw_string': return parseRawString(node);
    case 'concatenation': {
      let concatenated = '';
      for (const part of node.namedChildren) {
        const parsed = part ? parseLiteralShellWord(part) : undefined;
        if (parsed === undefined) return undefined;
        concatenated += parsed;
      }
      return concatenated || undefined;
    }
    default: return undefined;
  }
}

function parseLiteralCommandFromNode(command: Node): string[] | undefined {
  if (command.type !== 'command') return undefined;
  const words: string[] = [];
  let foundCommandName = false;
  for (const child of command.namedChildren) {
    if (!child) continue;
    if (child.type === 'command_name') {
      const name = child.namedChild(0);
      const parsed = name ? parseLiteralShellWord(name) : undefined;
      if (parsed === undefined) return undefined;
      words.push(parsed);
      foundCommandName = true;
    } else if (foundCommandName) {
      const word = parseLiteralShellWord(child);
      if (word !== undefined) words.push(word);
    }
  }
  return foundCommandName ? words : undefined;
}

function fileStem(path: string): string | undefined {
  const name = path.split('/').filter(Boolean).pop();
  if (!name || name === '.' || name === '..') return undefined;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

type ShellType = 'zsh' | 'sh' | 'cmd' | 'bash' | 'powershell';

export function detectShellType(shellPath: string): ShellType | undefined {
  switch (shellPath) {
    case 'zsh': case 'sh': case 'cmd': case 'bash': return shellPath;
    case 'pwsh': case 'powershell': return 'powershell';
  }
  const stem = fileStem(shellPath);
  return stem !== undefined && stem !== shellPath ? detectShellType(stem) : undefined;
}

function rmArgsIncludeForceOption(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end))
    .some(arg => arg === '--force' || (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('f')));
}

export class Shell {
  constructor(private readonly parser: Parser) {}

  /** Guardian's own walks over the syntax tree, such as the database boundary's; undefined when the script has errors. */
  parseTree<T>(src: string, read: (root: Node) => T | undefined): T | undefined {
    return this.withTree(src, read);
  }

  private withTree<T>(src: string, read: (root: Node) => T | undefined): T | undefined {
    const tree = this.parser.parse(src);
    if (!tree) return undefined;
    try {
      return tree.rootNode.hasError ? undefined : read(tree.rootNode);
    } finally {
      tree.delete();
    }
  }

  /**
   * Plain commands joined only by `&&`, `||`, `;`, `|`; undefined when the script contains anything
   * else (parentheses, redirections, substitutions, control flow, expansions).
   */
  parseShellScriptIntoCommands(src: string): string[][] | undefined {
    return this.withTree(src, root => {
      const stack: Node[] = [root];
      const commandNodes: Node[] = [];
      for (let node = stack.pop(); node; node = stack.pop()) {
        const kind = node.type;
        if (node.isNamed) {
          if (!ALLOWED_KINDS.has(kind)) return undefined;
          if ((kind === 'word' || kind === 'number') && !isLiteralWordOrNumber(node)) return undefined;
          if (kind === 'command') commandNodes.push(node);
        } else if (!ALLOWED_PUNCT_TOKENS.has(kind) && kind.trim()) {
          return undefined;
        }
        for (const child of node.children) if (child) stack.push(child);
      }
      commandNodes.sort((left, right) => left.startIndex - right.startIndex);
      const commands: string[][] = [];
      for (const node of commandNodes) {
        const words = parsePlainCommandFromNode(node);
        if (!words) return undefined;
        commands.push(words);
      }
      return commands;
    });
  }

  extractBashCommand(command: readonly string[]): [shell: string, script: string] | undefined {
    if (command.length !== 3) return undefined;
    const [shell, flag, script] = command;
    if (flag !== '-lc' && flag !== '-c') return undefined;
    const type = detectShellType(shell);
    return type === 'zsh' || type === 'bash' || type === 'sh' ? [shell, script] : undefined;
  }

  /** The plain commands inside `bash -lc "..."` when the script is word-only. */
  parseShellLcPlainCommands(command: readonly string[]): string[][] | undefined {
    const extracted = this.extractBashCommand(command);
    return extracted && this.parseShellScriptIntoCommands(extracted[1]);
  }

  /**
   * Statically known words from every command node of a valid script. Suitable for spotting
   * dangerous literal commands; never use it to prove a command is safe.
   */
  parseShellLcLiteralCommands(command: readonly string[]): string[][] | undefined {
    const extracted = this.extractBashCommand(command);
    if (!extracted) return undefined;
    return this.withTree(extracted[1], root => {
      const commands: string[][] = [];
      const stack: Node[] = [root];
      for (let node = stack.pop(); node; node = stack.pop()) {
        if (node.type === 'command') {
          const words = parseLiteralCommandFromNode(node);
          if (words) commands.push(words);
        }
        for (const child of node.namedChildren) if (child) stack.push(child);
      }
      return commands;
    });
  }

  /**
   * Every command this one may run, as far as static parsing can tell: itself, the commands behind `sudo`,
   * `env` and `trap`, and the literal commands of any shell script it carries, recursively. The Railway
   * boundary uses this to find a Railway invocation wherever a literal command hides. Codex walks the same tree in
   * `dangerous_command_match_with_depth`; here the walk collects commands instead of matching `rm`.
   */
  expandLiteralCommands(command: readonly string[], wrapperDepth = 0): string[][] {
    if (wrapperDepth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return [];
    const expanded = [[...command]];
    const unwrapped = this.unwrapCommand(command);
    const nested = [...(unwrapped ? [unwrapped] : []), ...this.parseShellLcLiteralCommands(command) ?? []];
    for (const inner of nested) {
      if (!inner.length || inner.join('\0') === command.join('\0')) continue;
      expanded.push(...this.expandLiteralCommands(inner, wrapperDepth + 1));
    }
    return expanded;
  }

  /** The command behind a `sudo`, `env` or `trap` wrapper, if any. */
  private unwrapCommand(command: readonly string[]): string[] | undefined {
    switch (command[0]?.split('/').pop() || undefined) {
      case 'sudo': return command.slice(1);
      case 'env': {
        let index = 1;
        for (; index < command.length; index++) {
          const argument = command[index];
          if (argument === '--') { index++; break; }
          const name = argument.split('=', 1)[0];
          const assignment = argument.includes('=') && name !== '' && !name.startsWith('-');
          if (argument !== '-i' && argument !== '--ignore-environment' && !assignment) break;
        }
        return command.slice(index);
      }
      case 'trap': {
        const action = command[command[1] === '--' ? 2 : 1];
        return action === undefined || action.startsWith('-') ? undefined : ['sh', '-c', action];
      }
      default: return undefined;
    }
  }

  dangerousCommandMatch(command: readonly string[], wrapperDepth = 0): DangerousCommandMatch | undefined {
    if (wrapperDepth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return 'other';
    const direct = this.dangerousCommandMatchForExec(command, wrapperDepth);
    if (direct) return direct;
    // Any literal command in a shell script might be dangerous, including commands nested in control flow or substitutions.
    for (const nested of this.parseShellLcLiteralCommands(command) ?? []) {
      const match = this.dangerousCommandMatch(nested, wrapperDepth + 1);
      if (match) return match;
    }
    return undefined;
  }

  private dangerousCommandMatchForExec(command: readonly string[], wrapperDepth: number): DangerousCommandMatch | undefined {
    if (command[0]?.split('/').pop() === 'rm') return rmArgsIncludeForceOption(command.slice(1)) ? 'forced_rm' : undefined;
    const unwrapped = this.unwrapCommand(command);
    return unwrapped && this.dangerousCommandMatch(unwrapped, wrapperDepth + 1);
  }
}

let loading: Promise<Shell> | undefined;

export function loadShell(): Promise<Shell> {
  return loading ??= (async () => {
    await Parser.init();
    const language = await Language.load(createRequire(import.meta.url).resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
    const parser = new Parser();
    parser.setLanguage(language);
    return new Shell(parser);
  })();
}
