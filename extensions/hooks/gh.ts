import { basename } from 'node:path';
import { invocations } from './shell.ts';

export const undecodableGh = "Hooks cannot check numeric, Unicode, control, or unknown $'...' escapes in gh commands. Use plain quotes.";

export interface GhPrCommand {
  action: 'create' | 'merge';
  flags: Set<string>;
}

const valueFlags: Record<GhPrCommand['action'], string[]> = {
  create: ['--assignee', '--attach', '--base', '--body', '--body-file', '--head', '--label', '--milestone', '--project', '--recover', '--reviewer', '--template', '--title', '--repo'],
  merge: ['--author-email', '--body', '--body-file', '--match-head-commit', '--subject', '--repo'],
};
const shortValueFlags: Record<GhPrCommand['action'], string> = { create: 'aBbFHlmprTtR', merge: 'AbFtR' };

function flags(args: string[], action: GhPrCommand['action']): Set<string> {
  const found = new Set<string>();
  const record = (name: string, value?: string) => {
    if (value === undefined || ['1', 't', 'T', 'true', 'TRUE', 'True'].includes(value)) found.add(name);
    else found.delete(name);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (valueFlags[action].includes(name)) { if (!arg.includes('=')) i++; }
      else record(name, arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined);
    } else if (arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (shortValueFlags[action].includes(flag)) { if (j === arg.length - 1) i++; break; }
        const value = arg[j + 1] === '=' ? arg.slice(j + 2) : undefined;
        const name = flag === 'h' ? '--help' : action === 'create' && flag === 'd' ? '--draft' : action === 'create' && flag === 'w' ? '--web' : `-${flag}`;
        record(name, value);
        if (value !== undefined) break;
      }
    }
  }
  return found;
}

/**
 * The effective `gh pr create|new|merge` invocations in a Bash command, excluding help requests.
 * A gh command holding an escape the tokenizer could not decode yields 'undecodable'.
 */
export function ghPrCommands(source: string): (GhPrCommand | 'undecodable')[] {
  const found: (GhPrCommand | 'undecodable')[] = [];
  for (const { name, args: rest } of invocations(source)) {
    if (basename(name) !== 'gh' && !name.includes('\0')) continue;
    if ([name, ...rest].some(word => word.includes('\0'))) { found.push('undecodable'); continue; }
    const args = [...rest], selected: string[] = [];
    for (let level = 0; level < 2; level++) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') break;
        if (arg.startsWith('-')) {
          if (!arg.includes('=') && ((arg.startsWith('--') && arg !== '--help'
            && !(level === 0 && arg === '--version')) || arg.length === 2)) i++;
          continue;
        }
        if (!arg) continue;
        selected.push(arg);
        args.splice(i, 1);
        break;
      }
    }
    if (selected[0] !== 'pr') continue;
    const action = selected[1] === 'new' ? 'create' : selected[1];
    if (action !== 'create' && action !== 'merge') continue;
    const options = flags(args, action);
    if (!options.has('--help')) found.push({ action, flags: options });
  }
  return found;
}
