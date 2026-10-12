import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TIMEOUT_BOUNDS } from './task.ts';
import { abortable } from './cancellation.ts';

interface Stage { signature: string; value: unknown }
interface JournalOptions { signal?: AbortSignal; onFailure?: (error: Error) => void }
const runningIdentities = new Set<string>();
const STAGE_CAP = 1024 * 1024;
const JOURNAL_CAP = 32 * STAGE_CAP;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN_COUNT = 16;
const IDLE_MS = 2 * TIMEOUT_BOUNDS.maximum;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function pruneJournals(directory: string): Promise<void> {
  const now = Date.now();
  const journals: { path: string; idle: number }[] = [];
  const removals: Promise<void>[] = [];
  const remove = (path: string) => removals.push(rm(path, { recursive: true, force: true }).catch(() => {}));
  for (const name of await readdir(directory)) {
    const match = /^([0-9a-f]{64})(\.json(?:\.[0-9a-f-]{36}\.tmp)?)?$/.exec(name);
    if (!match || runningIdentities.has(match[1]))
      continue;
    const path = resolve(directory, name);
    let idle: number;
    try { idle = now - (await lstat(path)).mtimeMs; } catch { continue; }
    if (!match[2])
      journals.push({ path, idle });
    else if (idle > IDLE_MS)
      remove(path);
  }
  journals.sort((a, b) => a.idle - b.idle).forEach(({ path, idle }, index) => {
    if (idle > RETAIN_MS || index >= RETAIN_COUNT && idle > IDLE_MS)
      remove(path);
  });
  await Promise.all(removals);
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

export class WorkflowJournal {
  private stages: Record<string, Stage> = {};
  private sizes = new Map<string, number>();
  private bytes = 0;
  private reserved = 0;
  private waiters: (() => void)[] = [];
  private queue = Promise.resolve();
  private created = false;
  private closed = false;
  private path: string;

  private constructor(private directory: string, private identity: string, private options: JournalOptions) {
    this.path = resolve(directory, identity);
  }

  static async open(directory: string, identity: string, options: JournalOptions = {}): Promise<WorkflowJournal> {
    if (runningIdentities.has(identity))
      throw new Error('Identical workflow is already running');
    runningIdentities.add(identity);
    const journal = new WorkflowJournal(directory, identity, options);
    try { await journal.load(); return journal; }
    catch (error) { await journal.close(); throw error; }
  }

  get keys(): string[] { return Object.keys(this.stages); }

  lookup(key: string, signature?: string): Stage | undefined {
    const stage = this.stages[key];
    if (stage && signature !== undefined && stage.signature !== signature)
      throw new Error('Stage label reused for a different task');
    return stage;
  }

  async touch(): Promise<void> {
    if (this.created)
      await utimes(this.path, new Date(), new Date()).catch(() => {});
  }

  async record<T>(key: string, signature: string, perform: () => Promise<T>): Promise<T> {
    await this.reserve(STAGE_CAP);
    try {
      const value = await perform();
      await this.persist(key, {signature, value}, STAGE_CAP);
      return value;
    }
    finally { this.release(STAGE_CAP); }
  }

  async checkpoint(key: string, value: unknown): Promise<void> {
    const stage = {signature: 'checkpoint', value};
    const bytes = Buffer.byteLength(JSON.stringify({version: 2, identity: this.identity, key, ...stage}), 'utf8');
    if (bytes > STAGE_CAP)
      throw Object.assign(new Error('Workflow checkpoint exceeds the 1 MiB journal record limit'), {retryable: false});
    await this.reserve(bytes);
    try { await this.persist(key, stage, bytes); }
    finally { this.release(bytes); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => {});
    runningIdentities.delete(this.identity);
  }

  private async reserve(bytes: number): Promise<void> {
    while (this.bytes + this.reserved + bytes > JOURNAL_CAP) {
      if (!this.reserved)
        throw Object.assign(new Error('Workflow journal budget exhausted; split the workflow or reduce stage output'), {retryable: false});
      await abortable(new Promise<void>(wake => this.waiters.push(wake)), this.options.signal);
    }
    this.reserved += bytes;
  }

  private release(bytes: number): void {
    this.reserved -= bytes;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await pruneJournals(this.directory).catch(() => {});
    let names: string[] = [];
    try {
      if (!(await lstat(this.path)).isDirectory())
        throw new Error('Workflow journal must be a directory');
      names = await readdir(this.path);
      this.created = true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    const loaded: { key: string; stage: Stage; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name))
        continue;
      const { text, length, mtimeMs } = await readStage(resolve(this.path, name));
      if ((this.bytes += length) > JOURNAL_CAP)
        throw new Error('Workflow journal exceeds limit');
      const record = JSON.parse(text);
      if (!record || typeof record !== 'object' || record.version !== 2 || record.identity !== this.identity || typeof record.key !== 'string' || !/^(?:spawn|checkpoint):[a-zA-Z0-9_.-]{1,80}$/.test(record.key) || `${digest(record.key)}.json` !== name || typeof record.signature !== 'string')
        throw new Error('Invalid workflow journal');
      this.sizes.set(record.key, length);
      loaded.push({ key: record.key, stage: { signature: record.signature, value: record.value }, mtimeMs });
    }
    for (const { key, stage } of loaded.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : 1)))
      this.stages[key] = stage;
  }
  private persist(key: string, stage: Stage, reservation: number) {
    this.queue = this.queue.then(async () => {
      const data = JSON.stringify({ version: 2, identity: this.identity, key, ...stage });
      const bytes = Buffer.byteLength(data, 'utf8');
      const previous = this.sizes.get(key) ?? 0;
      if (bytes > STAGE_CAP || this.bytes - previous + this.reserved - reservation + bytes > JOURNAL_CAP)
        throw new Error('Workflow journal exceeds limit');
      if (!this.created) {
        await mkdir(this.path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        if (!(await lstat(this.path)).isDirectory())
          throw new Error('Workflow journal must be a directory');
        this.created = true;
      }
      const path = resolve(this.path, `${digest(key)}.json`);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
        await rename(temp, path);
        this.stages[key] = stage;
        this.sizes.set(key, bytes);
        this.bytes += bytes - previous;
      }
      finally {
        await rm(temp, { force: true });
      }
    }).catch(cause => {
      const error = new Error(`Workflow persistence failed; reconcile external effects before retrying: ${String(cause)}`);
      this.options.onFailure?.(error);
      throw error;
    });
    return this.queue;
  }
}
