import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type ts from 'typescript';
import { validateTask, validateTimeout, type TaskSpec } from './registry.ts';
import { thinkingSuffix } from './thinking.ts';
import { abortable } from './cancellation.ts';
import { assertTaskFields } from './profiles.ts';
import { insideRoot } from './scope.ts';
interface WorkflowOptions {
  source: string;
  cwd: string;
  journalDirectory: string;
  policyIdentity: string;
  allowedTools?: () => string[];
  defaultTask?: Pick<TaskSpec, 'model' | 'thinking'>;
  profileIdentity?: string;
  normalizeTask?: (task: TaskSpec) => TaskSpec;
  approve?: (source: string) => Promise<boolean>;
  approveReplay?: (stages: string[]) => Promise<boolean>;
  authorizeRead?: (path: string) => Promise<void>;
  spawn: (task: TaskSpec, signal: AbortSignal) => Promise<unknown>;
  validateTask?: (task: Awaited<ReturnType<typeof validateTask>>) => Promise<void>;
  signal?: AbortSignal;
  timeout?: number;
}
interface Journal {
  version: 1;
  identity: string;
  stages: Record<string, {
    signature: string;
    value: unknown;
  }>;
}
const runningIdentities = new Set<string>();
const CAP = 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);
// The TypeScript compiler is ~1.3s and ~12MB of startup this extension only
// needs when an approved workflow is actually compiled.
let compiler: Promise<typeof ts> | undefined;
const typescript = () => (compiler ??= import('typescript').then(module => module.default));
// Pi may itself be a Bun executable. Probe Node independently and use the
// returned absolute executable, never Pi's emulated process.versions.node.
async function workflowRuntime(signal?: AbortSignal) {
  const env = { PATH: process.env.PATH };
  let runtime: {
    execPath: string;
    version: string;
    bun?: string;
  };
  try {
    const { stdout } = await execFileAsync('node', ['-p', 'JSON.stringify({execPath:process.execPath,version:process.versions.node,bun:process.versions.bun})'], { env, signal, timeout: 5000, maxBuffer: 4096 });
    runtime = JSON.parse(stdout);
    if (!runtime || typeof runtime !== 'object')
      throw new Error('Invalid Node probe response');
  }
  catch (error) {
    throw new Error('Workflow requires a real Node executable on PATH (Node 22.19+ or 24+)', {cause: error});
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(runtime.version ?? '');
  const major = Number(parts?.[1]), minor = Number(parts?.[2]);
  if (runtime.bun || !parts || !(major >= 24 || major === 22 && minor >= 19))
    throw new Error(`Unsupported workflow Node version: ${runtime.version}`);
  if (typeof runtime.execPath !== 'string' || !isAbsolute(runtime.execPath))
    throw new Error('Workflow requires an absolute Node executable path');
  const permissionFlag = major >= 24 ? '--permission' : '--experimental-permission';
  try {
    // Check the actual permission model, including denied filesystem/process
    // capabilities, before sending any approved workflow to this executable.
    const { stdout } = await execFileAsync(runtime.execPath, [permissionFlag, '--input-type=module', '-e', `
 import { readFileSync } from 'node:fs';
 import { spawnSync } from 'node:child_process';
 if (process.versions.bun || process.versions.node !== ${JSON.stringify(runtime.version)} || !process.permission || process.permission.has('fs.read') || process.permission.has('fs.write') || process.permission.has('child') || process.permission.has('worker')) process.exit(1);
 for (const operation of [()=>readFileSync(process.execPath),()=>spawnSync(process.execPath,['--version'])]) {
 try { operation(); process.exit(1); } catch (error) { if(error.code !== 'ERR_ACCESS_DENIED') process.exit(1); }
 }
 process.stdout.write('permissions-ok');
 `], { env, signal, timeout: 5000, maxBuffer: 4096 });
    if (stdout !== 'permissions-ok')
      throw new Error('Permission probe failed');
  }
  catch (error) {
    throw new Error('Workflow Node permission capability probe failed', {cause: error});
  }
  return { ...runtime, permissionFlag };
}
/** Body of async function workflow(api), compiled only after exact source approval. */
export async function runWorkflow(options: WorkflowOptions): Promise<unknown> {
  const timeout = validateTimeout(options.timeout, 'Workflow timeout');
  // Load the compiler before the run's deadline starts, exactly as an eager
  // module-level import did; the caller's timeout budget is for the workflow.
  await typescript();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try { return await runApprovedWorkflow({...options, timeout, signal}); }
  finally { clearTimeout(timer); }
}

async function runApprovedWorkflow(options: WorkflowOptions & {timeout: number}): Promise<unknown> {
  if (typeof options.source !== 'string' || !options.source.trim() || options.source.length > 64000)
    throw new Error('Workflow source must contain 1–64000 characters');
  if (options.signal?.aborted)
    throw new Error('Workflow aborted');
  let approved = false;
  try {
    approved = await abortable(options.approve?.(options.source) ?? false, options.signal);
  }
  catch (error) {
    if (options.signal?.aborted) throw new Error('Workflow aborted', {cause: error});
    throw new Error('Workflow approval failed', {cause: error});
  }
  if (!approved)
    throw new Error('Workflow requires explicit source approval');
  const runtime = await workflowRuntime(options.signal);
  const tsc = await typescript();
  const cwd = await realpath(options.cwd);
  const identity = digest(JSON.stringify({ version: 1, source: options.source, cwd, policy: options.policyIdentity, defaults: options.defaultTask, profiles: options.profileIdentity, node: runtime.version, typescript: tsc.version, platform: process.platform }));
  if (runningIdentities.has(identity))
    throw new Error('Identical workflow is already running');
  const compiled = tsc.transpileModule(`async function workflow(api: any) {\n${options.source}\n}`, { compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.None }, reportDiagnostics: true });
  const errors = compiled.diagnostics?.filter(d => d.category === tsc.DiagnosticCategory.Error) ?? [];
  if (errors.length)
    throw new Error(tsc.flattenDiagnosticMessageText(errors[0].messageText, '\n'));
  runningIdentities.add(identity);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted)
    controller.abort();
  const pending = new Set<Promise<void>>();
  let journal: Journal = { version: 1, identity, stages: {} };
  let writeQueue = Promise.resolve();
  const journalPath = resolve(options.journalDirectory, `${identity}.json`);
  let persistenceError: Error | undefined;
  const persist = (key: string, stage: Journal['stages'][string]) => {
    writeQueue = writeQueue.then(async () => {
      const candidate = {...journal, stages: {...journal.stages, [key]: stage}};
      const data = JSON.stringify(candidate);
      if (Buffer.byteLength(data, 'utf8') > CAP)
        throw new Error('Workflow journal exceeds limit');
      const temp = `${journalPath}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
        await rename(temp, journalPath);
        journal = candidate;
      }
      finally {
        await rm(temp, { force: true });
      }
    }).catch(error => {
      persistenceError = new Error(`Workflow persistence failed; reconcile external effects before retrying: ${String(error)}`);
      controller.abort();
      throw persistenceError;
    });
    return writeQueue;
  };
  try {
    await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Workflow journal must be a regular file');
        if (info.size > CAP) throw new Error('Workflow journal exceeds limit');
        const bytes = Buffer.alloc(CAP + 1);
        let length = 0;
        while (length < bytes.length) {
          const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > CAP) throw new Error('Workflow journal exceeds limit');
        journal = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      }
      finally {
        await handle.close();
      }
      if (journal.version !== 1 || journal.identity !== identity || !journal.stages || typeof journal.stages !== 'object' || Array.isArray(journal.stages))
        throw new Error('Invalid workflow journal');
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    if (Object.keys(journal.stages).length && (!options.approveReplay || !await abortable(options.approveReplay(Object.keys(journal.stages)), controller.signal)))
      throw new Error('Workflow replay approval declined');
    if (controller.signal.aborted)
      throw new Error('Workflow aborted');
    const workerPath = fileURLToPath(new URL('./workflow-worker.mjs', import.meta.url));
    const worker = spawn(runtime.execPath, [runtime.permissionFlag, '--max-old-space-size=64', `--allow-fs-read=${workerPath}`, workerPath], { cwd, detached: true, env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let workerError = '';
    worker.stderr?.on('data', chunk => { workerError = (workerError + String(chunk)).slice(-8000); });
    const stop = () => {
      if (worker.pid)
        try {
          process.kill(-worker.pid, 'SIGKILL');
        }
        catch { /* Already gone. */ }
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeout);
    const activeStages = new Set<string>();
    const capabilities = async (message: Record<string, unknown>) => {
      if (controller.signal.aborted)
        throw new Error('Workflow aborted');
      const { id, operation } = message;
      if (!message.args || typeof message.args !== 'object' || Array.isArray(message.args))
        throw new Error('Invalid workflow arguments');
      const args = message.args as Record<string, unknown>;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 1000)
        throw new Error('Invalid workflow request');
      const key = operation === 'spawn' ? `spawn:${args?.stage}` : `checkpoint:${args?.key}`;
      if (operation === 'spawn') {
        if (!args?.task || typeof args.task !== 'object' || Array.isArray(args.task) || typeof args.stage !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(args.stage))
          throw new Error('Invalid child task or stage label');
        if (activeStages.has(key))
          throw new Error('Concurrent duplicate spawn stage');
        activeStages.add(key);
        try {
          const input = args.task as Record<string, unknown>;
          assertTaskFields(input);
          if (input.cwd !== undefined && typeof input.cwd !== 'string')
            throw new Error('Invalid child cwd');
          // validateTask checks every task field at this untrusted IPC boundary.
          const inherited = {...options.defaultTask, ...input, cwd: input.cwd ? resolve(cwd, input.cwd) : cwd};
          if (input.thinking === undefined && typeof input.model === 'string') inherited.thinking = thinkingSuffix.exec(input.model)?.[1] ?? options.defaultTask?.thinking;
          const task = await validateTask(options.normalizeTask ? options.normalizeTask({...input, cwd: inherited.cwd} as unknown as TaskSpec) : inherited as unknown as TaskSpec, options.allowedTools?.());
          if (options.defaultTask && !task.model) throw new Error('A selected parent model or explicit provider/model is required');
          if (!insideRoot(cwd, task.cwd))
            throw new Error('Child cwd escapes workflow cwd');
          const signature = digest(JSON.stringify(task));
          const cached = journal.stages[key];
          if (cached) {
            if (cached.signature !== signature)
              throw new Error('Stage label reused for a different task');
            await abortable(options.validateTask?.(task), controller.signal);
            return cached.value;
          }
          const value = await options.spawn(task, controller.signal);
          if (controller.signal.aborted)
            throw new Error('Workflow aborted');
          await persist(key, { signature, value });
          return value;
        }
        finally {
          activeStages.delete(key);
        }
      }
      if (operation === 'readFile') {
        if (typeof args?.path !== 'string' || typeof args.maxBytes !== 'number' || !Number.isInteger(args.maxBytes) || args.maxBytes < 1 || args.maxBytes > 65536)
          throw new Error('Invalid bounded readFile request');
        const path = await realpath(resolve(cwd, args.path));
        if (!insideRoot(cwd, path))
          throw new Error('readFile escapes workflow cwd');
        const authorizedFile = await stat(path);
        await abortable(options.authorizeRead?.(path), controller.signal);
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const openedFile = await file.stat();
          if (!openedFile.isFile())
            throw new Error('readFile requires a regular file');
          if (openedFile.dev !== authorizedFile.dev || openedFile.ino !== authorizedFile.ino)
            throw new Error('readFile target changed during authorization');
          const bytes = Buffer.alloc(args.maxBytes + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > args.maxBytes)
            throw new Error('readFile exceeds byte limit');
          return bytes.subarray(0, bytesRead).toString('utf8');
        }
        finally {
          await file.close();
        }
      }
      if (operation === 'checkpointGet' || operation === 'checkpointPut') {
        if (typeof args?.key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(args.key))
          throw new Error('Invalid checkpoint');
        if (operation === 'checkpointGet')
          return Object.hasOwn(journal.stages, key) ? { found: true, value: journal.stages[key].value } : { found: false };
        await persist(key, { signature: 'checkpoint', value: args.value });
        return null;
      }
      throw new Error('Unknown workflow capability');
    };
    try {
      return await new Promise((resolveResult, reject) => {
        let settled = false;
        worker.on('error', reject);
        worker.on('close', code => {
          if (!settled)
            reject(persistenceError ?? new Error(controller.signal.aborted ? 'Workflow aborted or timed out' : `Workflow worker exited ${code}: ${workerError}`));
        });
        worker.on('message', (incoming: unknown) => {
          if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))
            return;
          const message = incoming as Record<string, unknown>;
          if (message?.type === 'done') {
            settled = true;
            if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 256 * 1024) {
              reject(new Error('Workflow result exceeds 256 KiB limit'));
              stop();
              return;
            }
            if (message.ok && pending.size)
              reject(new Error('Workflow finished with unfinished capability calls'));
            else if (message.ok)
              resolveResult(message.value);
            else
              reject(new Error(String(message.error)));
            stop();
            return;
          }
          if (message?.type !== 'request')
            return;
          const request = (async () => {
            try {
              const value = await capabilities(message);
              if (worker.connected && !controller.signal.aborted)
                worker.send({ type: 'response', id: message.id, ok: true, value }, () => { });
            }
            catch (error) {
              if (worker.connected && !controller.signal.aborted)
                worker.send({ type: 'response', id: message.id, ok: false, error: String(error instanceof Error ? error.message : error), retryable: (error as {retryable?: boolean} | null)?.retryable !== false }, () => { });
            }
          })();
          pending.add(request);
          void request.finally(() => pending.delete(request));
        });
        worker.send({ type: 'start', code: compiled.outputText }, error => {
          if (error)
            reject(error);
        });
      });
    }
    finally {
      clearTimeout(timer);
      controller.abort();
      stop();
      controller.signal.removeEventListener('abort', stop);
      if (worker.exitCode === null && worker.signalCode === null)
        await new Promise<void>(resolveExit => worker.once('close', () => resolveExit()));
    }
  }
  finally {
    controller.abort();
    await Promise.allSettled(pending);
    await writeQueue.catch(() => { });
    options.signal?.removeEventListener('abort', abort);
    runningIdentities.delete(identity);
  }
}
