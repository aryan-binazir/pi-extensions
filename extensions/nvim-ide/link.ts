import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { watch, type FSWatcher } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type WebSocket from 'ws';

/** `ws` costs ~17 ms and ~12 MB; load it only once an editor is actually there. */
let wsModule: Promise<typeof WebSocket> | undefined;
const loadWs = () => (wsModule ??= import('ws').then(m => m.default));
const OPEN = 1, CLOSED = 3;

export interface Position { line: number; character: number }
export interface Selection { text: string; filePath: string; start: Position; end: Position; isEmpty: boolean }
export interface Mention { filePath: string; lineStart?: number; lineEnd?: number }
export interface Lock { port: number; pid: number; authToken: string; workspaceFolders: string[]; ideName: string; mtimeMs: number }
export interface LinkState { connected: boolean; ideName?: string; port?: number; selection?: Selection; mentions: number }

/** Selection text kept in memory and sent to the model is capped here; nvim sends the whole visual range. */
export const maxSelectionChars = 4000;
export const defaultLockDir = (): string => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'ide');
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const trimSep = (path: string): string => path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;

export async function readLocks(dir: string, alive: (pid: number) => boolean = pidAlive): Promise<Lock[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const locks: Lock[] = [];
  for (const name of names) {
    const port = /^(\d+)\.lock$/.exec(name)?.[1];
    if (!port) continue;
    try {
      const file = join(dir, name);
      const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const data = JSON.parse(raw) as Partial<Lock> & { transport?: string };
      if (data.transport !== 'ws' || typeof data.authToken !== 'string' || !Number.isInteger(data.pid) || !Array.isArray(data.workspaceFolders)) continue;
      if (!alive(data.pid as number)) continue;
      locks.push({ port: Number(port), pid: data.pid as number, authToken: data.authToken, workspaceFolders: data.workspaceFolders.filter((f): f is string => typeof f === 'string').map(f => trimSep(resolve(f))), ideName: typeof data.ideName === 'string' ? data.ideName : 'IDE', mtimeMs: info.mtimeMs });
    } catch { /* unreadable or partial lock file: skip it */ }
  }
  return locks;
}

/** Same rule Claude Code uses: an env-selected port wins, else the live lock whose workspace contains cwd, longest match then newest. */
export function chooseLock(locks: Lock[], cwd: string, envPort = process.env.CLAUDE_CODE_SSE_PORT): Lock | undefined {
  const port = Number(envPort);
  if (Number.isInteger(port)) { const hit = locks.find(lock => lock.port === port); if (hit) return hit; }
  const here = trimSep(resolve(cwd));
  let best: { lock: Lock; depth: number } | undefined;
  for (const lock of locks) for (const folder of lock.workspaceFolders) {
    if (here !== folder && !here.startsWith(folder + sep)) continue;
    if (!best || folder.length > best.depth || (folder.length === best.depth && lock.mtimeMs > best.lock.mtimeMs)) best = { lock, depth: folder.length };
  }
  return best?.lock;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type Content = { type: string; text?: string }[];

export interface LinkOptions {
  cwd: string;
  onChange?: (state: LinkState) => void;
  lockDir?: string;
  retryMs?: number;
  requestTimeoutMs?: number;
  alive?: (pid: number) => boolean;
}

/** One client connection to an IDE's Claude Code server; reconnects on its own while started. */
export class IdeLink {
  private socket?: WebSocket;
  private lock?: Lock;
  private started = false;
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private selection?: Selection;
  private mentions: Mention[] = [];
  private ready = false;
  constructor(private readonly options: LinkOptions) {}

  get state(): LinkState { return { connected: this.ready, ideName: this.lock?.ideName, port: this.lock?.port, selection: this.selection, mentions: this.mentions.length }; }
  get connected(): boolean { return this.ready; }

  start(): void { if (this.started) return; this.started = true; this.watchLocks(); void this.attempt(); }
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.watcher?.close(); this.watcher = undefined;
    const socket = this.socket;
    this.drop(new Error('IDE link stopped'));
    if (socket && socket.readyState !== CLOSED) await new Promise<void>(done => { socket.once('close', () => done()); socket.close(); setTimeout(() => { socket.terminate(); done(); }, 500).unref(); });
  }
  /** Force a fresh discovery pass now instead of waiting for the retry timer. */
  reconnect(): void { const socket = this.socket; this.drop(new Error('reconnecting')); socket?.terminate(); void this.attempt(); }
  takeMentions(): Mention[] { const taken = this.mentions; this.mentions = []; if (taken.length) this.emit(); return taken; }

  /** Call an IDE tool; returns the text content or throws the IDE's error text. */
  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }, signal) as { content?: Content; isError?: boolean } | undefined;
    const text = (result?.content ?? []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n');
    if (result?.isError) throw new Error(text || `${name} failed`);
    return text;
  }

  private async attempt(): Promise<void> {
    if (!this.started || this.socket) return;
    const lock = chooseLock(await readLocks(this.options.lockDir ?? defaultLockDir(), this.options.alive), this.options.cwd);
    if (!this.started || this.socket) return;
    if (!lock) { this.schedule(); return; }
    const WebSocket = await loadWs();
    if (!this.started || this.socket) return;
    this.lock = lock;
    const socket = new WebSocket(`ws://127.0.0.1:${lock.port}`, { headers: { 'x-claude-code-ide-authorization': lock.authToken }, handshakeTimeout: 3000, perMessageDeflate: false });
    this.socket = socket;
    socket.on('message', data => this.receive(data.toString()));
    socket.on('error', () => { /* close follows; handled there */ });
    socket.on('close', () => { if (this.socket === socket) { this.drop(new Error('IDE disconnected')); this.schedule(); } });
    socket.once('open', () => {
      this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pi-nvim-ide', version: '1' } })
        .then(() => { if (this.socket !== socket) return; this.notify('notifications/initialized'); this.ready = true; this.emit(); })
        .catch(() => socket.terminate());
    });
  }
  /** A lock file appearing or changing wakes discovery at once; the poll below is only a fallback (the directory may not exist yet, and some filesystems do not report changes). */
  private watchLocks(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.options.lockDir ?? defaultLockDir(), { persistent: false }, (_event, name) => { if (!this.started || this.socket || (name && !name.endsWith('.lock'))) return; if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } this.schedule(200); });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch { /* directory missing: the poll handles it and a later attempt retries the watch */ }
  }
  private schedule(delay = this.options.retryMs ?? 15000): void {
    if (!this.started || this.timer) return;
    if (!this.watcher) this.watchLocks();
    this.timer = setTimeout(() => { this.timer = undefined; void this.attempt(); }, delay);
    this.timer.unref();
  }
  private drop(error: Error): void {
    const wasReady = this.ready;
    this.socket?.removeAllListeners('close');
    this.socket = undefined; this.ready = false; this.lock = undefined; this.selection = undefined;
    for (const [id, item] of this.pending) { clearTimeout(item.timer); this.pending.delete(id); item.reject(error); }
    if (wasReady) this.emit();
  }
  private emit(): void { this.options.onChange?.(this.state); }
  private send(message: object): void { if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message)); }
  private notify(method: string, params?: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== OPEN) { reject(new Error('IDE not connected')); return; }
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      const id = this.nextId++;
      const finish = (fn: () => void) => { const item = this.pending.get(id); if (!item) return; clearTimeout(item.timer); this.pending.delete(id); signal?.removeEventListener('abort', onAbort); fn(); };
      const onAbort = () => finish(() => reject(new Error('aborted')));
      const timer = setTimeout(() => finish(() => reject(new Error(`${method} timed out`))), this.options.requestTimeoutMs ?? 30000);
      timer.unref();
      this.pending.set(id, { resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)), timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  private receive(raw: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) { this.handleNotification(message.method, message.params); return; }
      if (message.method === 'ping') this.send({ jsonrpc: '2.0', id: message.id, result: {} });
      else this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (typeof message.id !== 'number') return;
    const item = this.pending.get(message.id);
    if (!item) return;
    if (message.error) item.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'IDE request failed'));
    else item.resolve(message.result);
  }
  private handleNotification(method: string, params: unknown): void {
    const data = (params ?? {}) as Record<string, unknown>;
    if (method === 'selection_changed') {
      const range = (data.selection ?? {}) as Partial<Selection>;
      if (typeof data.filePath !== 'string' || !isPosition(range.start) || !isPosition(range.end)) return;
      const raw = typeof data.text === 'string' ? data.text : '';
      const text = raw.length > maxSelectionChars ? raw.slice(0, maxSelectionChars) : raw;
      this.selection = { text, filePath: data.filePath, start: range.start, end: range.end, isEmpty: range.isEmpty === true || text.length === 0 };
      this.emit();
    } else if (method === 'at_mentioned') {
      if (typeof data.filePath !== 'string') return;
      const line = (value: unknown) => Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
      if (this.mentions.length >= 50) this.mentions.shift();
      this.mentions.push({ filePath: data.filePath, lineStart: line(data.lineStart), lineEnd: line(data.lineEnd) });
      this.emit();
    }
  }
}
const isPosition = (value: unknown): value is Position => !!value && typeof value === 'object' && Number.isInteger((value as Position).line) && Number.isInteger((value as Position).character);
