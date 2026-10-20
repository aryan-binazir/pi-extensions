import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { decide, policyState, resolveStep, type Plan } from './policy.ts';

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Stop', 'StopFailure'];
const MIN_CLAUDE_VERSION = [2, 1, 302];
const START_TIMEOUT_MS = 45_000;
const JOB_TIMEOUT_MS = 150_000;
const MAX_HOOK_BODY = 32 * 1024 * 1024;
const MAX_PAGE_BYTES = 10 * 1024 * 1024;

/** The hook payload fields this runner reads; Claude Code sends more. */
interface HookInput {
  hook_event_name?: unknown; session_id?: unknown; transcript_path?: unknown; scratchpad_dir?: unknown; prompt?: unknown;
  tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; tool_response?: unknown; error?: unknown; last_assistant_message?: unknown;
}
type Settle = { ok: true; responses: unknown[] } | { ok: false; error: Error };
/**
 * `cwd` is the job's own folder under the helper folder (a staged page's folder); without it the job makes one.
 * `stopAfter` ends the job early after a planned call's result, for example when an update's read is stale.
 */
interface ConverseOptions { signal?: AbortSignal; cwd?: string; stopAfter?: (step: number, response: unknown) => boolean }

const helperRoot = () => join(getAgentDir(), 'claude-artifacts', 'helper');
const verifiedPaths = new Set<string>();

/** The Artifact tool reported a failure for the planned call at `step`; `refused` means the service published nothing. */
export class ArtifactToolError extends Error {
  readonly refused: boolean;
  constructor(readonly step: number, readonly detail: string) {
    super(`Claude Code's Artifact tool failed: ${detail}`);
    this.refused = /^(Publish refused|You hadn't viewed the live version)/.test(detail);
  }
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
export interface Staged {
  source: string; dir: string; file: string; name: string; sha256: string; bytes: number; text: string;
  verify(reportedPath: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export async function stage(path: string): Promise<Staged> {
  if (!/\.html?$/i.test(path)) throw new Error(`Only an .html or .htm page can be published: ${path}`);
  const source = await realpath(path);
  const content = await readPage(source);
  const root = helperRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'job-')), name = basename(source), file = join(dir, name);
  const dispose = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await writeFile(file, content, { mode: 0o400, flag: 'wx' });
    const sha256 = hash(content);
    const verify = async (reportedPath: unknown) => {
      const same = typeof reportedPath === 'string' && await realpath(reportedPath).then(async real => real === await realpath(file), () => false);
      if (!same) throw new Error(`Claude Code reported uploading ${String(reportedPath)}, not the approved file.`);
      if (hash(await readFile(file)) !== sha256) throw new Error('The approved copy changed before Claude Code uploaded it.');
    };
    return { source, dir, file, name, sha256, bytes: content.length, text: content.toString('utf8'), verify, dispose };
  } catch (error) { await dispose(); throw error; }
}

/** Reads a regular file of at most MAX_PAGE_BYTES through one descriptor, so a swapped-in FIFO cannot block. */
async function readPage(source: string) {
  const handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${source}`);
    if (info.size > MAX_PAGE_BYTES) throw new Error(`The page is larger than ${MAX_PAGE_BYTES / 1024 / 1024} MiB: ${source}`);
    const content = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(content, 0, info.size, 0);
    return content.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/** Runs one hidden interactive `claude` session that may make exactly the Artifact calls the plan lists. */
export async function converse(plan: Plan, { signal, cwd: given, stopAfter }: ConverseOptions = {}): Promise<unknown[]> {
  const { steps } = plan;
  const env = claudeEnv();
  signal?.throwIfAborted();
  await requireVersion(env);
  const sessionId = randomUUID(), token = randomBytes(24).toString('hex');
  await mkdir(helperRoot(), { recursive: true, mode: 0o700 });
  const cwd = given ?? await mkdtemp(join(helperRoot(), 'job-'));
  const handshake = `PIJOB ${randomBytes(16).toString('hex')}: carry out the Pi artifact job instruction supplied in the hook context for this prompt. If no such instruction is present, do nothing and reply "no job".`;
  const policy = policyState(), responses: unknown[] = [], resolved = new Set<number>(), written: { transcript?: unknown; scratchpad?: unknown } = {};
  let started = false, settled = false, settle!: (outcome: Settle) => void;
  const outcome = new Promise<Settle>(resolve => { settle = value => { settled = true; resolve(value); }; });
  const fail = (message: string): Settle => ({ ok: false, error: new Error(message) });
  const done = { continue: false, stopReason: 'Pi artifact job finished.' };

  const respond = async (input: HookInput): Promise<object> => {
    if (input.session_id !== sessionId) throw new Error('hook from an unexpected session');
    written.transcript ??= input.transcript_path; written.scratchpad ??= input.scratchpad_dir;
    if (settled) return closed(input.hook_event_name);
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
        const id = String(input.tool_use_id), step = policy.reserved.get(id);
        if (step === undefined) return {};
        responses[step] = input.tool_response; resolved.add(step); resolveStep(policy, id);
        if (step < steps.length - 1 && !stopAfter?.(step, input.tool_response)) return {};
        settle({ ok: true, responses });
        return done;
      }
      case 'PostToolUseFailure': {
        const step = policy.reserved.get(String(input.tool_use_id));
        if (step === undefined) return {};
        const error = new ArtifactToolError(step, String(input.error ?? 'unknown error'));
        if (steps[step].input.action !== 'publish' || error.refused) resolved.add(step);
        settle({ ok: false, error });
        return done;
      }
      case 'PermissionRequest':
      case 'PermissionDenied':
        settle(fail(`Claude Code hit a permission prompt the job does not allow (${String(input.tool_name)}).`));
        return closed(input.hook_event_name);
      case 'Stop':
      case 'StopFailure':
        settle(fail(`Claude Code stopped without completing the job: ${String(input.last_assistant_message ?? input.error ?? 'no message')}`));
        return {};
      default:
        return {};
    }
  };

  const scratch = await mkdtemp(join(tmpdir(), 'pi-ca-')), socket = join(scratch, 'tmux.sock');
  const tmux = (...args: string[]) => run('tmux', ['-S', socket, ...args], env);
  const watch = async () => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!settled) {
      await delay(250);
      const screen = await tmux('capture-pane', '-p', '-t', 'job').catch(() => '');
      const dead = (await tmux('display-message', '-p', '-t', 'job', '#{pane_dead}').catch(() => '1')).trim() === '1';
      if (settled) return;
      if (started) { if (dead) settle(fail(`Claude Code exited before finishing the job.${lastScreen(screen)}`)); continue; }
      const blocker = startupBlocker(screen, dead, helperRoot());
      if (blocker) settle(fail(blocker));
      else if (Date.now() > deadline) settle(fail(`Claude Code did not reach Pi's hooks within ${START_TIMEOUT_MS / 1000} s, so nothing was sent to it.${lastScreen(screen)}`));
    }
  };

  let hooks: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    hooks = await listen(token, respond);
    const settings = join(scratch, 'settings.json'), tmuxConf = join(scratch, 'tmux.conf');
    await writeFile(tmuxConf, 'set -g remain-on-exit on\n', { mode: 0o600 });
    const hook = { type: 'http', url: hooks.url, timeout: 30, onFailure: 'block' };
    await writeFile(settings, JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ matcher: '*', hooks: [hook] }]])) }), { mode: 0o600 });
    await run('tmux', ['-S', socket, '-f', tmuxConf, 'new-session', '-d', '-s', 'job', '-x', '200', '-y', '50', '-c', cwd,
      'claude', '--restricted', '--tools', 'Artifact,Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
      '--model', 'haiku', '--session-id', sessionId, '--settings', settings, handshake], env);
    const timer = setTimeout(() => settle(fail('The Claude artifact job timed out.')), JOB_TIMEOUT_MS);
    const cancel = () => settle(fail('The Claude artifact job was cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    void watch();
    try {
      const result = await outcome;
      if (result.ok) return result.responses;
      const pending = [...policy.reserved.values()].some(step => steps[step].input.action === 'publish' && !resolved.has(step));
      if (pending) throw new Error(`${result.error.message} Claude Code was already allowed to publish, so the outcome is unknown: check claude_artifact_list before retrying.`);
      throw result.error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  } finally {
    settled = true;
    const pid = Number(await tmux('display-message', '-p', '-t', 'job', '#{pane_pid}').catch(() => ''));
    await tmux('kill-server').catch(() => {});
    await stopped(pid);
    await hooks?.close();
    await removeSessionFiles(sessionId, written, cwd);
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (!given) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** The answer to any hook once the job has ended: refuse and stop. */
function closed(event: unknown): object {
  const reason = 'The Pi artifact job has ended.';
  if (event === 'PreToolUse') return { continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  if (event === 'PermissionRequest') return { continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } };
  if (event === 'UserPromptSubmit') return { decision: 'block', reason };
  return { continue: false, stopReason: reason };
}

/** Waits for the pane's process group to end after the hangup, then kills whatever is left. */
async function stopped(pid: number) {
  if (!(pid > 0) || await gone(pid, 3_000)) return;
  for (const target of [-pid, pid]) try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
  await gone(pid, 2_000);
}

async function gone(pid: number, ms: number) {
  const alive = () => [-pid, pid].some(target => { try { process.kill(target, 0); return true; } catch { return false; } });
  for (let waited = 0; waited < ms; waited += 50) {
    if (!alive()) return true;
    await delay(50);
  }
  return !alive();
}

/**
 * Deletes the transcript (it holds a copy of the page) and the session's folders. Claude Code keeps state under
 * folders named after the working directory; the job's own folders, named after its unique working directory, go
 * whole, including the empty scratchpad Claude Code starts under a second, unreported id. Anything else goes only
 * when named by this session's id.
 */
async function removeSessionFiles(sessionId: string, written: { transcript?: unknown; scratchpad?: unknown }, cwd: string) {
  const owned = new Set([folderName(cwd), folderName(await realpath(cwd).catch(() => cwd))]);
  const targets: string[] = [];
  if (typeof written.transcript === 'string' && basename(written.transcript) === `${sessionId}.jsonl`) {
    const project = dirname(written.transcript);
    targets.push(...owned.has(basename(project)) ? [project] : [written.transcript, join(project, sessionId)]);
  }
  if (typeof written.scratchpad === 'string' && basename(dirname(written.scratchpad)) === sessionId) {
    const sessions = dirname(dirname(written.scratchpad));
    targets.push(owned.has(basename(sessions)) ? sessions : dirname(written.scratchpad));
  }
  for (const target of targets) {
    const info = await lstat(target).catch(() => undefined);
    if (info && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true }).catch(() => {});
  }
}

const folderName = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');

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
  return `Pi artifact job instruction: the user approved exactly these calls. ${calls} Make one call at a time and wait for each result. Publish files as they are; you do not need to read them first. Call no other tools. Do not merge, edit or retry anything. Then reply "done".`;
}

/** The user's environment without API keys, provider switches or parent Claude Code session state. */
function claudeEnv(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE)/.test(key) || key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_OAUTH_TOKEN');
  return { ...Object.fromEntries(kept), DISABLE_AUTOUPDATER: '1' };
}

async function requireVersion(env: NodeJS.ProcessEnv) {
  const key = env.PATH ?? '';
  if (verifiedPaths.has(key)) return;
  const output = await run('claude', ['--version'], env).catch(error => { throw new Error(`Could not run Claude Code (\`claude --version\`): ${error.message}`); });
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output)?.slice(1).map(Number);
  const first = found ? MIN_CLAUDE_VERSION.findIndex((part, index) => part !== found[index]) : 0;
  if (!found || first !== -1 && found[first] < MIN_CLAUDE_VERSION[first]) throw new Error(`Claude Code ${found?.join('.') ?? output.trim()} is older than ${MIN_CLAUDE_VERSION.join('.')}, the oldest version these tools were verified with. Update Claude Code and retry.`);
  verifiedPaths.add(key);
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
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
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
