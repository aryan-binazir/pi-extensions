import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getAgentDir, isToolCallEventType, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

function commands(source: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [], word = '', quote = '', started = false;
  const flushWord = () => { if (started) words.push(word); word = ''; started = false; };
  const flushCommand = () => { flushWord(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (char === '\\' && quote !== "'" && next !== undefined) {
      if (next === '\n') { i++; continue; }
      if (!quote || ['$', '`', '"', '\\'].includes(next)) { word += next; started = true; i++; continue; }
    }
    if (quote) {
      if (char === quote) quote = ''; else word += char;
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

const valueFlags: Record<string, string[]> = {
  create: ['--assignee', '--attach', '--base', '--body', '--body-file', '--head', '--label', '--milestone', '--project', '--recover', '--reviewer', '--template', '--title', '--repo'],
  merge: ['--author-email', '--body', '--body-file', '--match-head-commit', '--subject', '--repo'],
};
const shortValueFlags: Record<string, string> = { create: 'aBbFHlmprTtR', merge: 'AbFtR' };

function flags(args: string[], action: string): Set<string> {
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

export default function guard(pi: ExtensionAPI) {
  pi.on('tool_call', async event => {
    if (!isToolCallEventType('bash', event)) return;
    const path = join(getAgentDir(), 'guard.json');
    let config: { requireDraftPr: boolean; blockAdminMerge: boolean };
    try {
      config = JSON.parse(await readFile(path, 'utf8'));
      if (!config || typeof config.requireDraftPr !== 'boolean' || typeof config.blockAdminMerge !== 'boolean'
        || Object.keys(config).some(key => key !== 'requireDraftPr' && key !== 'blockAdminMerge')) {
        throw new Error('Expected only boolean requireDraftPr and blockAdminMerge settings');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          if ((await lstat(path)).isSymbolicLink()) {
            return { block: true, reason: `Fix ${path}: its symlink target is missing.` };
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return;
        }
      }
      return { block: true, reason: `Fix ${path} before running Bash: ${error instanceof Error ? error.message : String(error)}` };
    }
    for (const words of commands(event.input.command)) {
      let start = 0;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? '')) start++;
      if (basename(words[start] ?? '') !== 'gh') continue;
      const args = words.slice(start + 1), selected: string[] = [];
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
      if (options.has('--help')) continue;
      if (action === 'merge' && config.blockAdminMerge && options.has('--admin')) {
        return { block: true, reason: 'Merge without --admin. Satisfy the repository review and check requirements instead of bypassing them.' };
      }
      if (action === 'create' && config.requireDraftPr && options.has('--web')) {
        return { block: true, reason: 'gh cannot create drafts with --web. Drop --web/-w and pass --draft.' };
      }
      if (action === 'create' && config.requireDraftPr && !options.has('--draft')) {
        return { block: true, reason: 'Create PRs as drafts. Add --draft; mark ready with gh pr ready after review.' };
      }
    }
  });
}
