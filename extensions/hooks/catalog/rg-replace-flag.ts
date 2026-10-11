import { basename } from 'node:path';
import { invocations } from '../shell.ts';
import type { AdviseHook } from '../types.ts';

// ripgrep 15 options that take a value, so the word after them is that value rather than a flag.
const shortWithValue = 'efEmjgdtTABCMr';
const longWithValue = new Set([
  '--regexp', '--file', '--encoding', '--max-count', '--threads', '--glob', '--max-depth', '--type', '--type-not',
  '--after-context', '--before-context', '--context', '--max-columns', '--pre', '--pre-glob', '--dfa-size-limit',
  '--engine', '--regex-size-limit', '--iglob', '--ignore-file', '--max-filesize', '--type-add', '--type-clear', '--color',
  '--colors', '--context-separator', '--field-context-separator', '--field-match-separator', '--hostname-bin',
  '--hyperlink-format', '--path-separator', '--sort', '--sortr', '--generate',
]);

function replaces(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (name === '--replace') return true;
      if (longWithValue.has(name) && !arg.includes('=')) i++;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'r') return true;
        if (shortWithValue.includes(arg[j])) { if (j === arg.length - 1) i++; break; }
      }
    }
  }
  return false;
}

export const rgReplaceFlag: AdviseHook = {
  id: 'rg-replace-flag',
  type: 'advise',
  check({ toolName, input }) {
    if (toolName !== 'bash' || typeof input.command !== 'string') return;
    if (!invocations(input.command).some(({ name, args }) => basename(name) === 'rg' && replaces(args))) return;
    return 'In rg, -r means --replace: it rewrites each match in the output and does not mean recursive. rg already searches recursively, so drop -r unless you meant to replace.';
  },
};
