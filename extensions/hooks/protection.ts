import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveToolPath } from '../worktree/routing.ts';
import { enabledIn, parseSwitches, unknownIds } from './config.ts';
import { invocations } from './shell.ts';
import type { ToolCall } from './types.ts';

const switchesFile = `${sep}personal-settings${sep}hooks.yaml`;
const readOnlyCommands = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'stat', 'readlink', 'realpath', 'grep', 'cd', 'pwd', 'echo', 'true']);
const readOnlyGit = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'ls-files']);
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

function safeGit(args: string[]): boolean {
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '-C') i++;
    else if (args[i] !== '--no-pager') return false;
  }
  return readOnlyGit.has(args[i]) && !args.some(arg => arg.startsWith('--output') || arg === '--ext-diff');
}

// Best effort: anything beyond plain reads, diffs and commits of the switches is refused.
function safeBash(command: string): boolean {
  if (/[`<>]|\$\(/.test(command)) return false;
  return invocations(command).every(({ assignments, name, args }) =>
    !assignments.length && (readOnlyCommands.has(name) || (name === 'git' && safeGit(args))));
}

async function proposedText(call: ToolCall, path: string, current: string): Promise<string> {
  if (call.toolName === 'write') return String(call.input.content ?? '');
  let written: string | undefined;
  const edit = createEditToolDefinition(call.cwd, {
    operations: {
      readFile: async () => Buffer.from(current, 'utf8'),
      writeFile: async (_path, content) => { written = content; },
      access: async () => {},
    },
  });
  const input = edit.prepareArguments ? edit.prepareArguments(call.input) : call.input;
  await edit.execute('hooks-protection', { ...(input as object), path } as never, undefined, undefined, undefined as never);
  if (written === undefined) throw new Error('the edit produced no content');
  return written;
}

/** The always-on rule that lets agents switch hooks on but never off. */
export function createProtection(configPath: string, known: ReadonlySet<string>) {
  return async function protect(call: ToolCall): Promise<string | undefined> {
    if (call.toolName === 'bash' && typeof call.input.command === 'string') {
      const command = call.input.command;
      if (!/personal-settings|hooks\.yaml/.test(command) || safeBash(command)) return;
      return 'Agents cannot change personal-settings/hooks.yaml through Bash. Use the edit tool to switch hooks on; only the user can switch them off.';
    }
    if ((call.toolName !== 'edit' && call.toolName !== 'write') || typeof call.input.path !== 'string') return;
    const path = await canonical(resolveToolPath(call.input.path, call.cwd));
    const live = path === await canonical(configPath);
    if (!live && !path.endsWith(switchesFile)) return;

    let current = '';
    try {
      current = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `Cannot read ${path}: ${message(error)}`;
    }
    let before = new Set<string>();
    if (current) {
      try {
        before = enabledIn(parseSwitches(current));
      } catch (error) {
        return `${path} is currently invalid (${message(error)}); only the user can repair it.`;
      }
    }
    let proposed: string;
    try {
      proposed = await proposedText(call, path, current);
    } catch (error) {
      return `Cannot verify this edit to ${path}: ${message(error)}`;
    }
    let after: Map<string, boolean>;
    try {
      after = parseSwitches(proposed);
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
