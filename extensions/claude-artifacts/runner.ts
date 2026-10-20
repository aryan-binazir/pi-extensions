import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join, relative } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { decide, policyState, type Plan } from './policy.ts';

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Stop', 'StopFailure'];
const MIN_CLAUDE_VERSION = [2, 1, 302], START_TIMEOUT_MS = 45_000, JOB_TIMEOUT_MS = 150_000, MAX_HOOK_BODY = 32 * 1024 * 1024, MAX_PAGE_BYTES = 10 * 1024 * 1024;

/** The hook payload fields this runner reads; Claude Code sends more. */
interface HookInput { hook_event_name?: unknown; session_id?: unknown; transcript_path?: unknown; scratchpad_dir?: unknown; prompt?: unknown; tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; tool_response?: unknown; error?: unknown; last_assistant_message?: unknown }
type Settle = { ok: true; responses: unknown[] } | { ok: false; error: Error };
export interface ConverseOptions { signal?: AbortSignal; stopAfter?: StopAfter }
/** Lets a caller end the job early after a planned call's result, for example when an update's read is stale. */
export type StopAfter = (step: number, response: unknown) => boolean;

export const helperRoot = () => join(getAgentDir(), 'claude-artifacts', 'helper');

/** The Artifact tool itself reported a failure for the planned call at `step`. */
export class ArtifactToolError extends Error {
  constructor(readonly step: number, readonly detail: string) { super(`Claude Code's Artifact tool failed: ${detail}`); }
}

/** Saves artifact source privately for the model to read and returns its path. */
export async function saveSource(name: string, text: string) {
  const dir = join(getAgentDir(), 'claude-artifacts', 'reads');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name.replace(/[^\w.-]+/g, '-')}.txt`);
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

/** A read-only copy of the page in the helper folder: the exact bytes the user approves and Claude Code uploads. */
export interface Staged { source: string; file: string; relative: string; sha256: string; bytes: number; text: string; verify(reportedPath: unknown): Promise<void>; dispose(): Promise<void> }

export async function stage(source: string): Promise<Staged> {
  if (!/\.html?$/i.test(source)) throw new Error(`Only an .html or .htm page can be published: ${source}`);
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`Not a regular file: ${source}`);
  if (info.size > MAX_PAGE_BYTES) throw new Error(`The page is larger than ${MAX_PAGE_BYTES / 1024 / 1024} MiB: ${source}`);
  const root = helperRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'job-')), file = join(dir, basename(source));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    await copyFile(source, file, constants.COPYFILE_EXCL); await chmod(file, 0o400);
    const content = await readFile(file), sha256 = hash(content);
    const verify = async (reportedPath: unknown) => {
      const same = typeof reportedPath === 'string' && await realpath(reportedPath).then(async real => real === await realpath(file), () => false);
      if (!same) throw new Error(`Claude Code reported uploading ${String(reportedPath)}, not the approved file.`);
      if (hash(await readFile(file)) !== sha256) throw new Error('The approved copy changed before Claude Code uploaded it.');
    };
    return { source, file, relative: relative(root, file), sha256, bytes: content.length, text: content.toString('utf8'), verify, dispose };
  } catch (error) { await dispose(); throw error; }
}

const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/** Runs one hidden interactive `claude` session that may make exactly the Artifact calls the plan lists. */
export async function converse(plan: Plan, { signal, stopAfter }: ConverseOptions = {}): Promise<unknown[]> {
  const { steps } = plan;
  const env = claudeEnv();
  signal?.throwIfAborted();
  await requireVersion(env);
  const sessionId = randomUUID(), token = randomBytes(24).toString('hex');
  const cwd = helperRoot();
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(tmpdir(), 'pi-ca-')), socket = join(scratch, 'tmux.sock');
  const handshake = `PIJOB ${token}: carry out the Pi artifact job instruction supplied in the hook context for this prompt. If no such instruction is present, do nothing and reply "no job".`;
  const policy = policyState(), responses: unknown[] = [], resolved = new Set<number>(), written: { transcript?: unknown; scratchpad?: unknown } = {};
  let started = false, settled = false, settle!: (outcome: Settle) => void;
  const outcome = new Promise<Settle>(resolve => { settle = value => { settled = true; resolve(value); }; });
  const fail = (message: string): Settle => ({ ok: false, error: new Error(message) });
  const tmux = (...args: string[]) => run('tmux', ['-S', socket, ...args], env);

  const respond = async (input: HookInput): Promise<object> => {
    if (input.session_id !== sessionId) throw new Error('hook from an unexpected session');
    written.transcript ??= input.transcript_path; written.scratchpad ??= input.scratchpad_dir;
    switch (input.hook_event_name) {
      case 'UserPromptSubmit':
        if (started || input.prompt !== handshake) return { decision: 'block', reason: 'Only the Pi artifact job prompt may run in this session.' };
        started = true;
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: instruction(steps) } };
      case 'PreToolUse': {
        const toolInput = typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input as Record<string, unknown> : {};
        const decision = decide(plan, policy, { tool: String(input.tool_name), input: toolInput, id: String(input.tool_use_id) });
        if (!decision.allow && decision.fatal) settle(fail(`Claude Code kept making calls the job does not allow: ${decision.reason}`));
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.allow ? 'allow' : 'deny', permissionDecisionReason: decision.allow ? 'Approved by Pi.' : decision.reason } };
      }
      case 'PostToolUse': {
        const step = policy.reserved.get(String(input.tool_use_id));
        if (step === undefined) return {};
        responses[step] = input.tool_response; resolved.add(step);
        if (step < steps.length - 1 && !stopAfter?.(step, input.tool_response)) return {};
        settle({ ok: true, responses });
        return { continue: false, stopReason: 'Pi artifact job finished.' };
      }
      case 'PostToolUseFailure': {
        const step = policy.reserved.get(String(input.tool_use_id));
        if (step === undefined) return {};
        resolved.add(step);
        settle({ ok: false, error: new ArtifactToolError(step, String(input.error ?? 'unknown error')) });
        return { continue: false, stopReason: 'Pi artifact job finished.' };
      }
      case 'PermissionRequest':
      case 'PermissionDenied':
        settle(fail(`Claude Code hit a permission prompt the job does not allow (${String(input.tool_name)}).`));
        return input.hook_event_name === 'PermissionRequest' ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Pi artifact jobs allow no permission prompts.' } } } : {};
      case 'Stop':
      case 'StopFailure':
        settle(fail(`Claude Code stopped without completing the job: ${String(input.last_assistant_message ?? input.error ?? 'no message')}`));
        return {};
      default:
        return {};
    }
  };

  const watchStartup = async () => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!started && !settled) {
      await delay(250);
      const screen = await tmux('capture-pane', '-p', '-t', 'job').catch(() => '');
      const dead = (await tmux('display-message', '-p', '-t', 'job', '#{pane_dead}').catch(() => '1')).trim() === '1';
      if (started || settled) return;
      const blocker = startupBlocker(screen, dead, cwd);
      if (blocker) settle(fail(blocker));
      else if (Date.now() > deadline) settle(fail(`Claude Code did not reach Pi's hooks within ${START_TIMEOUT_MS / 1000} s, so nothing was sent to it.${lastScreen(screen)}`));
    }
  };

  const hooks = await listen(token, respond), launched = Date.now();
  try {
    const settings = join(scratch, 'settings.json'), tmuxConf = join(scratch, 'tmux.conf');
    await writeFile(tmuxConf, 'set -g remain-on-exit on\n', { mode: 0o600 });
    await writeFile(settings, JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ matcher: '*', hooks: [{ type: 'http', url: hooks.url, timeout: 30, onFailure: 'block' }] }]])) }), { mode: 0o600 });
    await run('tmux', ['-S', socket, '-f', tmuxConf, 'new-session', '-d', '-s', 'job', '-x', '200', '-y', '50', '-c', cwd,
      'claude', '--restricted', '--tools', 'Artifact,Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
      '--model', 'haiku', '--session-id', sessionId, '--settings', settings, handshake], env);
    const timer = setTimeout(() => settle(fail('The Claude artifact job timed out.')), JOB_TIMEOUT_MS);
    const cancel = () => settle(fail('The Claude artifact job was cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    void watchStartup();
    try {
      const result = await outcome;
      if (result.ok) return result.responses;
      const pending = [...policy.reserved.values()].some(step => steps[step].input.action === 'publish' && !resolved.has(step));
      if (pending) throw new Error(`${result.error.message} Claude Code was already allowed to publish, so the outcome is unknown: check claude_artifact_list before retrying.`);
      throw result.error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  } finally {
    const pid = Number(await tmux('display-message', '-p', '-t', 'job', '#{pane_pid}').catch(() => ''));
    await tmux('kill-server').catch(() => {});
    await exited(pid);
    await hooks.close();
    await rm(scratch, { recursive: true, force: true });
    await removeSessionFiles(sessionId, written, launched);
  }
}

async function exited(pid: number) {
  for (let waited = 0; pid > 0 && waited < 5_000; waited += 50) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
}

/**
 * Deletes the transcript (it holds a copy of the page) and session folders, but only paths named by this session's id.
 * Claude Code also starts an empty scratchpad under a second id that no hook reports; empty ones made since launch go too.
 */
async function removeSessionFiles(sessionId: string, written: { transcript?: unknown; scratchpad?: unknown }, since: number) {
  const targets: string[] = [];
  if (typeof written.transcript === 'string' && basename(written.transcript) === `${sessionId}.jsonl`) targets.push(written.transcript, join(dirname(written.transcript), sessionId));
  const sessions = typeof written.scratchpad === 'string' && basename(dirname(written.scratchpad)) === sessionId ? dirname(dirname(written.scratchpad)) : undefined;
  if (sessions) targets.push(join(sessions, sessionId));
  for (const target of targets) {
    const info = await lstat(target).catch(() => undefined);
    if (info && !info.isSymbolicLink()) await rm(target, { recursive: info.isDirectory(), force: true });
  }
  if (!sessions) return;
  for (const entry of await readdir(sessions).catch(() => [])) {
    const dir = join(sessions, entry), info = await lstat(dir).catch(() => undefined);
    if (info?.isDirectory() && info.mtimeMs >= since - 1_000) await rmdir(join(dir, 'scratchpad')).then(() => rmdir(dir)).catch(() => {});
  }
}

function startupBlocker(screen: string, dead: boolean, cwd: string) {
  if (/trust this folder|Accessing workspace/i.test(screen)) return `Claude Code asks whether to trust the artifact helper folder ${cwd}. Trust it once: run \`claude\` in that folder, choose "Yes, I trust this folder", exit, and retry.`;
  if (/Select login method|Please run \/login|Not logged in/i.test(screen)) return 'Claude Code is not signed in to claude.ai. Run `claude`, sign in, and retry.';
  if (dead) return `Claude Code exited before the job started.${lastScreen(screen)}`;
}

function lastScreen(screen: string) {
  const lines = screen.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-12);
  return lines.length ? `\nLast screen:\n${lines.join('\n')}` : '';
}

function instruction(steps: Plan['steps']) {
  const calls = steps.map((step, index) => `Step ${index + 1}: call the Artifact tool with ${JSON.stringify(step.input)}.`).join(' ');
  return `Pi artifact job instruction: the user approved exactly these calls. ${calls} Publish files as they are; you do not need to read them first. Call no other tools. Do not merge, edit or retry anything. Then reply "done".`;
}

/** The user's environment without API keys, provider switches or parent Claude Code session state. */
function claudeEnv(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE)/.test(key) || key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_OAUTH_TOKEN');
  return { ...Object.fromEntries(kept), DISABLE_AUTOUPDATER: '1' };
}

async function requireVersion(env: NodeJS.ProcessEnv) {
  const output = await run('claude', ['--version'], env).catch(error => { throw new Error(`Could not run Claude Code (\`claude --version\`): ${error.message}`); });
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output)?.slice(1).map(Number);
  const first = found ? MIN_CLAUDE_VERSION.findIndex((part, index) => part !== found[index]) : 0;
  if (!found || first !== -1 && found[first] < MIN_CLAUDE_VERSION[first]) throw new Error(`Claude Code ${found?.join('.') ?? output.trim()} is older than ${MIN_CLAUDE_VERSION.join('.')}, the oldest version these tools were verified with. Update Claude Code and retry.`);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => execFile(command, args, { env, timeout: 15_000 }, (error, stdout, stderr) => error ? reject(new Error(`${command} failed: ${stderr || error.message}`)) : resolve(stdout)));
}

async function listen(token: string, respond: (input: HookInput) => Promise<object>) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== `/hook/${token}`) throw new Error('not found');
      const output = await respond(JSON.parse(await body(request)));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output));
    } catch { response.writeHead(403).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('hook server has no port');
  return { url: `http://127.0.0.1:${address.port}/hook/${token}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function body(request: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HOOK_BODY) throw new Error('hook body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

