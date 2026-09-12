import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createFindTool, createGrepTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import { resolveToolPath } from '../worktree/routing.ts';

const OUTPUT_LIMIT = 64000;

async function executable(names: string[], cwd: string, signal: AbortSignal): Promise<string> {
  const directories = [join(getAgentDir(), 'bin'), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
  for (const directory of directories) {
    for (const name of names) {
      signal.throwIfAborted();
      const candidate = resolve(cwd, directory, name + (process.platform === 'win32' ? '.exe' : ''));
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        return candidate;
      } catch { /* Missing or inaccessible candidates are never installed. */ }
    }
  }
  throw new Error(`Inspection dependency unavailable: ${names.join('/')}`);
}

/** Own the subprocess until close, including after abort, overflow, or spawn failure. */
async function run(names: string[], args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (!signal) throw new Error('Inspection requires a cancellation signal');
  signal.throwIfAborted();
  const binary = await executable(names, cwd, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let stdout = '', stderr = '', size = 0;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new Error('Inspection aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const collect = (chunk: string, isError: boolean) => {
      if (failure) return;
      if (size + chunk.length > OUTPUT_LIMIT) {
        stop(new Error('Inspection output budget exhausted'));
        return;
      }
      size += chunk.length;
      if (isError) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => collect(chunk, false));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => collect(chunk, true));
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (stderr || (code !== 0 && !(names[0] === 'rg' && code === 1))) {
        reject(new Error(`Inspection failed (${code}): ${stderr}`));
      } else resolve(stdout);
    });
  });
}

function bounded(value: number | undefined, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) throw new Error('Invalid inspection bound');
  return Math.min(value, max);
}

/** Reuse only SDK metadata/schema. Native execute and callbacks are never retained. */
export function createInspectionGrepTool(cwd: string): ReturnType<typeof createGrepTool> {
  const { name, label, parameters } = createGrepTool(cwd);
  return {
    name, label, parameters,
    description: 'Search file contents with bounded ripgrep. Files over 2MiB may be omitted. Results are not exhaustive; absence is not proof of safety.',
    async execute(_id, { pattern, path, glob, ignoreCase, literal, context, limit }, signal) {
      if (!signal) throw new Error('Inspection requires a cancellation signal');
      signal.throwIfAborted();
      const matches = bounded(limit, 100, 1000);
      const lines = bounded(context, 0, 20, 0);
      const args = ['--no-config', '--hidden', '--color=never', '--line-number', '--with-filename', '--no-heading',
        '--max-filesize=2M', `--max-count=${matches}`, `--context=${lines}`, `--regexp=${pattern}`];
      if (glob !== undefined) args.push(`--glob=${glob}`);
      if (ignoreCase) args.push('--ignore-case');
      if (literal) args.push('--fixed-strings');
      const target = resolveToolPath(path || '.', cwd);
      // rg ignores --max-filesize for explicitly named files. Reject those before spawning.
      const info = await stat(target);
      if (!info.isDirectory() && (!info.isFile() || info.size > 2 * 1024 * 1024)) {
        throw new Error('Inspection target must be a regular file of at most 2MiB or a directory');
      }
      args.push('--', target);
      const output = await run(['rg'], args, cwd, signal);
      return { content: [{ type: 'text', text: `${output || 'No matches found.'}\n[Bounded search: at most ${matches} matching lines per file, ${lines} context lines. Files >2MiB may be omitted; ignore rules and binary-file filtering also omit results. Results may be truncated and are not exhaustive. Absence is not proof of safety.]` }], details: undefined };
    },
  };
}

export function createInspectionFindTool(cwd: string): ReturnType<typeof createFindTool> {
  const { name, label, parameters } = createFindTool(cwd);
  return {
    name, label, parameters,
    description: 'Find paths by glob using installed fd/fdfind. Bounded results respect ignore rules and are not exhaustive; absence is not proof of safety.',
    async execute(_id, { pattern, path, limit }, signal) {
      const results = bounded(limit, 1000, 1000);
      const args = ['--glob', '--hidden', '--color=never', '--max-results', String(results)];
      if (pattern.includes('/')) {
        args.push('--full-path');
        if (!pattern.startsWith('/') && !pattern.startsWith('**/')) pattern = `**/${pattern}`;
        if (process.platform === 'win32') pattern = pattern.replaceAll('/', String.raw`[/\\]`);
      }
      args.push('--', pattern, resolveToolPath(path || '.', cwd));
      const output = await run(['fd', 'fdfind'], args, cwd, signal);
      return { content: [{ type: 'text', text: `${output || 'No files found.'}\n[Bounded search: at most ${results} results; reaching this limit truncates the search. Ignore rules may omit paths. Results are not exhaustive; absence is not proof of safety.]` }], details: undefined };
    },
  };
}
