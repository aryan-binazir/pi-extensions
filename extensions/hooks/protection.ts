import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { resolveToolPath } from '../tool-path.ts';
import { enabledIn, parseSwitches, unknownIds, type SwitchesFile } from './config.ts';
import { invocations } from './shell.ts';
import type { ToolCall } from './types.ts';

const switchesFile = `${sep}personal-settings${sep}hooks.yaml`;
const switchesName = /hooks\.yaml|personal-settings/;
const substitution = /`|\$\(|[<>]\(/;
const proseOptions: Record<string, string[]> = { git: ['-m', '--message'], gh: ['-b', '--body', '-t', '--title'] };
const readOnlyCommands = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'stat', 'readlink', 'realpath', 'grep', 'cd', 'pwd', 'echo', 'true']);
const readOnlyGit = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'ls-files']);
const runsPrograms = (arg: string) => ['--pre', '--hostname-bin'].some(option => arg === option || arg.startsWith(`${option}=`));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

function safeGit(args: readonly string[]): boolean {
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '-C') i++;
    else if (args[i] !== '--no-pager') return false;
  }
  return readOnlyGit.has(args[i]) && !args.some(arg => arg.startsWith('--output') || arg === '--ext-diff');
}

function isProse(name: string, args: readonly string[], i: number): boolean {
  const options = proseOptions[basename(name)] ?? [];
  return options.includes(args[i - 1]) || options.some(option => option.startsWith('--') && args[i].startsWith(`${option}=`));
}

function mentionsSwitches(command: string): boolean {
  if (substitution.test(command) && switchesName.test(command.replace(/['"\\]/g, ''))) return true;
  return invocations(command).some(({ assignments, name, args }) =>
    [...assignments, name].some(word => switchesName.test(word)) || args.some((arg, i) => switchesName.test(arg) && !isProse(name, args, i)));
}

function onlyReadsOrCommits(command: string): boolean {
  if (/[`<>]|\$\(/.test(command)) return false;
  return invocations(command).every(({ assignments, name, args }) => {
    const program = basename(name);
    return !assignments.length && (readOnlyCommands.has(program)
      || (program === 'rg' && !args.some(runsPrograms)) || (program === 'git' && safeGit(args)));
  });
}

/** The always-on rule that lets agents switch hooks on but never off. */
export function createProtection(configPath: string, known: ReadonlySet<string>) {
  return async function protect(call: ToolCall, readLive?: () => Promise<SwitchesFile>): Promise<string | undefined> {
    if (call.toolName === 'bash' && typeof call.input.command === 'string') {
      const command = call.input.command;
      if (!mentionsSwitches(command) || onlyReadsOrCommits(command)) return;
      return 'Agents cannot change personal-settings/hooks.yaml through Bash. Use the write tool to switch hooks on; only the user can switch them off.';
    }
    if ((call.toolName !== 'edit' && call.toolName !== 'write') || typeof call.input.path !== 'string') return;
    const requested = resolveToolPath(call.input.path, call.cwd);
    const path = await canonical(requested);
    const live = path === await canonical(configPath);
    if (!live && !requested.endsWith(switchesFile) && !path.endsWith(switchesFile)) return;
    if (call.toolName === 'edit') return `Change ${requested} with the write tool with the whole file. Edits apply to whatever the file holds when they run, so they cannot be checked.`;

    let current = '';
    let snapshot: SwitchesFile | undefined;
    try {
      if (live && readLive) { snapshot = await readLive(); current = snapshot.text; }
      else current = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `Cannot read ${path}: ${message(error)}`;
    }
    let before = new Set<string>();
    if (current) {
      try {
        before = enabledIn(snapshot ? snapshot.switches : parseSwitches(current));
      } catch (error) {
        return `${path} is currently invalid (${message(error)}); only the user can repair it.`;
      }
    }
    let after: Map<string, boolean>;
    try {
      after = parseSwitches(String(call.input.content ?? ''));
    } catch (error) {
      return `This change would leave ${path} invalid: ${message(error)}. Agents can only switch hooks on.`;
    }
    const unknown = live ? unknownIds(after, known) : [];
    if (unknown.length) return `This checkout has no hooks named: ${unknown.join(', ')}. Switch on only hooks that exist.`;
    const enabled = enabledIn(after);
    const switchedOff = [...before].filter(id => !enabled.has(id));
    if (switchedOff.length) return `Agents can switch hooks on but never off. This change would switch off: ${switchedOff.join(', ')}. Ask the user to make it.`;
  };
}
