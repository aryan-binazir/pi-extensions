import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { validateTask, type TaskSpec } from './registry.ts';
export interface WorkflowOptions {
  source: string;
  cwd: string;
  journalDirectory: string;
  policyIdentity: string;
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
const active = new Set<string>();
const CAP = 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
// Pi may itself be a Bun executable. Probe Node independently and use the
// returned absolute executable, never Pi's emulated process.versions.node.
async function workflowRuntime() {
  const env = { PATH: process.env.PATH };
  let runtime: {
    execPath: string;
    version: string;
    bun?: string;
  };
  try {
    const { stdout } = await execute('node', ['-p', 'JSON.stringify({execPath:process.execPath,version:process.versions.node,bun:process.versions.bun})'], { env, timeout: 5000, maxBuffer: 4096 });
    runtime = JSON.parse(stdout);
    if (!runtime || typeof runtime !== 'object')
      throw new Error('Invalid Node probe response');
  }
  catch {
    throw new Error('Workflow requires a real Node executable on PATH (Node 22.19+ or 24+)');
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
    const { stdout } = await execute(runtime.execPath, [permissionFlag, '--input-type=module', '-e', `
 import { readFileSync } from 'node:fs';
 import { spawnSync } from 'node:child_process';
 if (process.versions.bun || process.versions.node !== ${JSON.stringify(runtime.version)} || !process.permission || process.permission.has('fs.read') || process.permission.has('fs.write') || process.permission.has('child') || process.permission.has('worker')) process.exit(1);
 for (const operation of [()=>readFileSync(process.execPath),()=>spawnSync(process.execPath,['--version'])]) {
 try { operation(); process.exit(1); } catch (error) { if(error.code !== 'ERR_ACCESS_DENIED') process.exit(1); }
 }
 process.stdout.write('permissions-ok');
 `], { env, timeout: 5000, maxBuffer: 4096 });
    if (stdout !== 'permissions-ok')
      throw new Error('Permission probe failed');
  }
  catch {
    throw new Error('Workflow Node permission capability probe failed');
  }
  return { ...runtime, permissionFlag };
}
/** Body of async function workflow(api), compiled only after exact source approval. */
export async function runWorkflow(options: WorkflowOptions): Promise<unknown> {
  if (typeof options.source !== 'string' || !options.source.trim() || options.source.length > 64000)
    throw new Error('Workflow source must contain 1–64000 characters');
  if (options.signal?.aborted)
    throw new Error('Workflow aborted');
  let approved = false;
  try {
    approved = await options.approve?.(options.source) ?? false;
  }
  catch {
    throw new Error('Workflow approval failed');
  }
  if (!approved)
    throw new Error('Workflow requires explicit source approval');
  const runtime = await workflowRuntime();
  const cwd = await realpath(options.cwd);
  const identity = digest(JSON.stringify({ version: 1, source: options.source, cwd, policy: options.policyIdentity, node: runtime.version, typescript: ts.version, platform: process.platform }));
  if (active.has(identity))
    throw new Error('Identical workflow is already running');
  const compiled = ts.transpileModule(`async function workflow(api: any) {\n${options.source}\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length)
    throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, '\n'));
  const timeout = options.timeout ?? 600000;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600000)
    throw new Error('Workflow timeout must be 10–3600000 milliseconds');
  active.add(identity);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted)
    controller.abort();
  const pending = new Set<Promise<void>>();
  let journal: Journal = { version: 1, identity, stages: {} };
  let writeQueue = Promise.resolve();
  const journalPath = resolve(options.journalDirectory, `${identity}.json`);
  const persist = () => {
    writeQueue = writeQueue.then(async () => {
      const data = JSON.stringify(journal);
      if (data.length > CAP)
        throw new Error('Workflow journal exceeds limit');
      const temp = `${journalPath}.${randomUUID()}.tmp`;
      try {
        await (await open(temp, 'wx', 0o600)).close();
        await writeFile(temp, data);
        await rename(temp, journalPath);
      }
      finally {
        await rm(temp, { force: true });
      }
    });
    return writeQueue;
  };
  try {
    await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(journalPath, 'r');
      try {
        if ((await handle.stat()).size > CAP)
          throw new Error('Workflow journal exceeds limit');
        journal = JSON.parse(await handle.readFile('utf8'));
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
    if (Object.keys(journal.stages).length && (!options.approveReplay || !await options.approveReplay(Object.keys(journal.stages))))
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
    const abortWorker = () => stop();
    controller.signal.addEventListener('abort', abortWorker, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
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
          if (input.cwd !== undefined && typeof input.cwd !== 'string')
            throw new Error('Invalid child cwd');
          // validateTask checks every task field at this untrusted IPC boundary.
          const task = await validateTask({ ...input, cwd: input.cwd ? resolve(cwd, input.cwd) : cwd } as unknown as TaskSpec);
          const childRelative = relative(cwd, task.cwd);
          if (childRelative === '..' || childRelative.startsWith('../') || isAbsolute(childRelative))
            throw new Error('Child cwd escapes workflow cwd');
          const signature = digest(JSON.stringify(task));
          const cached = journal.stages[key];
          if (cached) {
            if (cached.signature !== signature)
              throw new Error('Stage label reused for a different task');
            await options.validateTask?.(task);
            return cached.value;
          }
          const value = await options.spawn(task, controller.signal);
          if (controller.signal.aborted)
            throw new Error('Workflow aborted');
          journal.stages[key] = { signature, value };
          await persist();
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
        const rel = relative(cwd, path);
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
          throw new Error('readFile escapes workflow cwd');
        await options.authorizeRead?.(path);
        const file = await open(path, 'r');
        try {
          if (!(await file.stat()).isFile())
            throw new Error('readFile requires a regular file');
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
        journal.stages[key] = { signature: 'checkpoint', value: args.value };
        await persist();
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
            reject(new Error(controller.signal.aborted ? 'Workflow aborted or timed out' : `Workflow worker exited ${code}: ${workerError}`));
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
                worker.send({ type: 'response', id: message.id, ok: false, error: String(error instanceof Error ? error.message : error) }, () => { });
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
      controller.signal.removeEventListener('abort', abortWorker);
      if (worker.exitCode === null && worker.signalCode === null)
        await new Promise<void>(resolveExit => worker.once('close', () => resolveExit()));
    }
  }
  finally {
    controller.abort();
    await Promise.allSettled(pending);
    await writeQueue.catch(() => { });
    options.signal?.removeEventListener('abort', abort);
    active.delete(identity);
  }
}
