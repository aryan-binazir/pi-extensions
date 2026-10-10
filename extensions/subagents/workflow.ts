import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, utimes } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type ts from 'typescript';
import { TIMEOUT_BOUNDS, validateTask, validateTimeout, type TaskSpec } from './registry.ts';
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
  readTools?: () => string[];
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
interface Stage {
  signature: string;
  value: unknown;
}
const runningIdentities = new Set<string>();
// Each stage is its own atomically replaced file, so a write costs one stage,
// not the whole journal. A child launches only after reserving STAGE_CAP.
const STAGE_CAP = 1024 * 1024;
const JOURNAL_CAP = 32 * STAGE_CAP;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN_COUNT = 16;
// Twice the longest workflow run: older journals cannot be in use by any Pi process.
const IDLE_MS = 2 * TIMEOUT_BOUNDS.maximum;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);
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
// Journals stay replayable until unused for RETAIN_MS; beyond the RETAIN_COUNT
// most recently used, idle ones go sooner. Legacy single-file journals match too.
async function pruneJournals(directory: string): Promise<void> {
  const now = Date.now();
  const entries: { path: string; idle: number }[] = [];
  for (const name of await readdir(directory)) {
    const identity = /^([0-9a-f]{64})(?:\.json(?:\.[0-9a-f-]{36}\.tmp)?)?$/.exec(name)?.[1];
    if (!identity || runningIdentities.has(identity))
      continue;
    const path = resolve(directory, name);
    try { entries.push({ path, idle: now - (await lstat(path)).mtimeMs }); } catch {}
  }
  entries.sort((a, b) => a.idle - b.idle);
  await Promise.all(entries.map(({ path, idle }, index) => idle > RETAIN_MS || index >= RETAIN_COUNT && idle > IDLE_MS ? rm(path, { recursive: true, force: true }).catch(() => {}) : undefined));
}
async function readStage(path: string): Promise<{ text: string; length: number; mtimeMs: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Workflow journal must be a regular file');
    if (info.size > STAGE_CAP) throw new Error('Workflow journal exceeds limit');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error('Workflow journal changed while loading');
    return { text: bytes.subarray(0, length).toString('utf8'), length, mtimeMs: info.mtimeMs };
  }
  finally {
    await handle.close();
  }
}
export async function runWorkflow(options: WorkflowOptions): Promise<unknown> {
  const timeout = validateTimeout(options.timeout, 'Workflow timeout');
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
  const identity = digest(JSON.stringify({ version: 2, source: options.source, cwd, policy: options.policyIdentity, defaults: options.defaultTask, profiles: options.profileIdentity, node: runtime.version, typescript: tsc.version, platform: process.platform }));
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
  const stages: Record<string, Stage> = {};
  const sizes = new Map<string, number>();
  let journalBytes = 0;
  let reserved = 0;
  let budgetWaiters: (() => void)[] = [];
  let writeQueue: Promise<unknown> = Promise.resolve();
  const journalPath = resolve(options.journalDirectory, identity);
  let journalCreated = false;
  let persistenceError: Error | undefined;
  const exhausted = () => Object.assign(new Error('Workflow journal budget exhausted; split the workflow or reduce stage output'), { retryable: false });
  // Spawns reserve STAGE_CAP before launching, so a launched child's record
  // always fits; with nothing in flight, an exhausted budget fails before launch.
  const reserve = async () => {
    while (journalBytes + reserved + STAGE_CAP > JOURNAL_CAP) {
      if (!reserved)
        throw exhausted();
      await abortable(new Promise<void>(wake => budgetWaiters.push(wake)), controller.signal);
    }
    reserved += STAGE_CAP;
  };
  const release = () => {
    reserved -= STAGE_CAP;
    const waiters = budgetWaiters;
    budgetWaiters = [];
    for (const wake of waiters) wake();
  };
  // Resolves false when an unreserved checkpoint does not fit: nothing ran
  // outside the worker, so the script gets a catchable error, not an abort.
  const persist = (key: string, stage: Stage, reservation = 0) => {
    const write = writeQueue.then(async () => {
      const data = JSON.stringify({ version: 2, identity, key, ...stage });
      const bytes = Buffer.byteLength(data, 'utf8');
      const previous = sizes.get(key) ?? 0;
      if (bytes > STAGE_CAP || journalBytes - previous + reserved - reservation + bytes > JOURNAL_CAP) {
        if (!reservation)
          return false;
        throw new Error('Workflow journal exceeds limit');
      }
      if (!journalCreated) {
        await mkdir(journalPath, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        journalCreated = true;
      }
      const path = resolve(journalPath, `${digest(key)}.json`);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
        await rename(temp, path);
        stages[key] = stage;
        sizes.set(key, bytes);
        journalBytes += bytes - previous;
        return true;
      }
      finally {
        await rm(temp, { force: true });
      }
    }).catch(error => {
      persistenceError = new Error(`Workflow persistence failed; reconcile external effects before retrying: ${String(error)}`);
      controller.abort();
      throw persistenceError;
    });
    writeQueue = write;
    return write;
  };
  try {
    await mkdir(options.journalDirectory, { recursive: true, mode: 0o700 });
    await pruneJournals(options.journalDirectory).catch(() => {});
    let names: string[] = [];
    try {
      if (!(await lstat(journalPath)).isDirectory())
        throw new Error('Workflow journal must be a directory');
      names = await readdir(journalPath);
      journalCreated = true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    const loaded: { key: string; stage: Stage; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name))
        continue;
      const { text, length, mtimeMs } = await readStage(resolve(journalPath, name));
      if ((journalBytes += length) > JOURNAL_CAP)
        throw new Error('Workflow journal exceeds limit');
      const record = JSON.parse(text);
      if (!record || typeof record !== 'object' || record.version !== 2 || record.identity !== identity || typeof record.key !== 'string' || !/^(?:spawn|checkpoint):[a-zA-Z0-9_.-]{1,80}$/.test(record.key) || `${digest(record.key)}.json` !== name || typeof record.signature !== 'string')
        throw new Error('Invalid workflow journal');
      sizes.set(record.key, length);
      loaded.push({ key: record.key, stage: { signature: record.signature, value: record.value }, mtimeMs });
    }
    for (const { key, stage } of loaded.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : 1)))
      stages[key] = stage;
    if (journalCreated)
      await utimes(journalPath, new Date(), new Date()).catch(() => {});
    if (Object.keys(stages).length && (!options.approveReplay || !await abortable(options.approveReplay(Object.keys(stages)), controller.signal)))
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
        catch {}
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
          const inherited = {...options.defaultTask, ...input, cwd: input.cwd ? resolve(cwd, input.cwd) : cwd};
          if (input.thinking === undefined && typeof input.model === 'string') inherited.thinking = thinkingSuffix.exec(input.model)?.[1] ?? options.defaultTask?.thinking;
          const task = await validateTask(options.normalizeTask ? options.normalizeTask({...input, cwd: inherited.cwd} as unknown as TaskSpec) : inherited as unknown as TaskSpec, options.allowedTools?.(), options.readTools?.());
          if (options.defaultTask && !task.model) throw new Error('A selected parent model or explicit provider/model is required');
          if (!insideRoot(cwd, task.cwd))
            throw new Error('Child cwd escapes workflow cwd');
          const signature = digest(JSON.stringify(task));
          const cached = stages[key];
          if (cached) {
            if (cached.signature !== signature)
              throw new Error('Stage label reused for a different task');
            await abortable(options.validateTask?.(task), controller.signal);
            return cached.value;
          }
          await reserve();
          try {
            const value = await options.spawn(task, controller.signal);
            if (controller.signal.aborted)
              throw new Error('Workflow aborted');
            await persist(key, { signature, value }, STAGE_CAP);
            return value;
          }
          finally {
            release();
          }
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
          return Object.hasOwn(stages, key) ? { found: true, value: stages[key].value } : { found: false };
        if (!await persist(key, { signature: 'checkpoint', value: args.value }))
          throw exhausted();
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
