import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const SERVICE = 'Harbor MCP OAuth';
const STATE_LIMIT = 64 * 1024;
const PROTOCOL_LIMIT = 128 * 1024;
const SOURCE_LIMIT = 256 * 1024;
const HELPER_TIMEOUT_MS = 120_000;
const COMPILER_TIMEOUT_MS = 30_000;
const LOCK_STARTUP_TIMEOUT_MS = 125_000;
const LOCK_OUTPUT_LIMIT = 64;
const LOCK_CLOSE_TIMEOUT_MS = 5_000;
const KEY = /^[a-f0-9]{64}$/;
const SOURCE_PATH = fileURLToPath(new URL('./keychain.swift', import.meta.url));
const XCRUN = '/usr/bin/xcrun';

export interface OAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirectUrl: string;
}

export interface OAuthStore {
  load(): Promise<OAuthState | undefined>;
  save(state: OAuthState): Promise<void>;
  delete(): Promise<void>;
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export type CredentialStoreErrorCode =
  | 'invalid-key'
  | 'invalid-state'
  | 'denied'
  | 'busy'
  | 'lock'
  | 'compiler-unavailable'
  | 'unavailable'
  | 'timeout';

/** An error whose message is safe to show to users and never includes helper output. */
export class CredentialStoreError extends Error {
  constructor(public readonly code: CredentialStoreErrorCode) {
    super(messageFor(code));
    this.name = 'CredentialStoreError';
  }
}

type HelperAction = 'load' | 'save' | 'delete';
type HelperRequest = { version: 1; action: HelperAction; service: typeof SERVICE; account: string; payload?: OAuthState };
type HelperRunner = (request: HelperRequest) => Promise<unknown>;

function messageFor(code: CredentialStoreErrorCode): string {
  switch (code) {
    case 'invalid-key': return 'Invalid OAuth credential storage key.';
    case 'invalid-state': return 'Stored OAuth credentials are invalid; re-authorize this MCP server.';
    case 'denied': return 'macOS Keychain access was denied; allow access and retry.';
    case 'busy': return 'OAuth credentials are busy in another Harbor process; retry shortly.';
    case 'lock': return 'OAuth credential locking is unavailable; check agent directory permissions and retry.';
    case 'compiler-unavailable': return 'OAuth credential storage requires a matching macOS Swift compiler and SDK; update Xcode Command Line Tools or set DEVELOPER_DIR to a working Xcode installation and retry.';
    case 'timeout': return 'OAuth credential storage timed out; check Keychain access and retry.';
    default: return 'OAuth credential storage is unavailable; unlock Keychain, check agent directory permissions, and retry.';
  }
}

function failure(code: CredentialStoreErrorCode): CredentialStoreError { return new CredentialStoreError(code); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { throw failure('invalid-state'); }
}

function validateRedirectUrl(value: unknown): string {
  if (typeof value !== 'string') throw failure('invalid-state');
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/callback$/.exec(value);
  const port = match ? Number(match[1]) : 0;
  if (!match || port < 1 || port > 65_535) throw failure('invalid-state');
  return value;
}

function validateState(value: unknown): OAuthState {
  if (!isRecord(value) || Object.keys(value).some(key => !['clientInformation', 'tokens', 'redirectUrl'].includes(key)) || jsonBytes(value) > STATE_LIMIT) {
    throw failure('invalid-state');
  }
  const state: OAuthState = { redirectUrl: validateRedirectUrl(value.redirectUrl) };
  if (value.clientInformation !== undefined) {
    const full = OAuthClientInformationFullSchema.safeParse(value.clientInformation);
    const information = full.success ? full : OAuthClientInformationSchema.safeParse(value.clientInformation);
    if (!information.success) throw failure('invalid-state');
    state.clientInformation = information.data;
  }
  if (value.tokens !== undefined) {
    const tokens = OAuthTokensSchema.safeParse(value.tokens);
    if (!tokens.success) throw failure('invalid-state');
    state.tokens = tokens.data;
  }
  if (jsonBytes(state) > STATE_LIMIT) throw failure('invalid-state');
  return state;
}

function ownUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw failure('unavailable');
  return uid;
}

async function secureAgentDirectory(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch { throw failure('unavailable'); }
  let canonical;
  try { canonical = await realpath(path); } catch { throw failure('unavailable'); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownUid() || (info.mode & 0o022) !== 0 || canonical !== resolve(path)) throw failure('unavailable');
}

async function securePrivateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failure('unavailable'); }
  let info;
  try { info = await lstat(path); } catch { throw failure('unavailable'); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownUid() || (info.mode & 0o777) !== 0o700) throw failure('unavailable');
}

async function secureFile(path: string, mode: number): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw failure('unavailable');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== ownUid() || (info.mode & 0o777) !== mode) throw failure('unavailable');
  return true;
}

interface ProcessResult { code: number | null; stdout: Buffer; timedOut: boolean; overflow: boolean; failed: boolean }

function runProcess(executable: string, args: string[], input: Buffer | undefined, timeoutMs: number, outputLimit: number, env: NodeJS.ProcessEnv = {}): Promise<ProcessResult> {
  return new Promise(resolve => {
    let settled = false, timedOut = false, overflow = false, failed = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const child = spawn(executable, args, { detached: true, env, shell: false, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
    const stdout = child.stdout!;
    const kill = () => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), timedOut, overflow, failed });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.once('error', () => { failed = true; finish(null); });
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) { overflow = true; kill(); return; }
      chunks.push(chunk);
    });
    child.once('close', finish);
    if (input) {
      const stdin = child.stdin!;
      stdin.on('error', () => undefined);
      stdin.end(input);
    }
  });
}

async function bundledSource(): Promise<Buffer> {
  let handle;
  try {
    handle = await open(SOURCE_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || ![ownUid(), 0].includes(info.uid) || (info.mode & 0o022) !== 0 || info.size > SOURCE_LIMIT) throw failure('unavailable');
    return await handle.readFile();
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    throw failure('unavailable');
  } finally { await handle?.close(); }
}

async function publishFile(path: string, contents: Buffer, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } catch { throw failure('unavailable'); }
  finally { await rm(temporary, { force: true }); }
  if (!(await secureFile(path, mode))) throw failure('unavailable');
}

async function compileHelper(agentDir: string): Promise<string> {
  await secureAgentDirectory(agentDir);
  const cache = join(agentDir, '.harbor-mcp-oauth');
  await securePrivateDirectory(cache);
  const source = await bundledSource();
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  const cachedSource = join(cache, `keychain-${sourceDigest}.swift`);
  if (!(await secureFile(cachedSource, 0o600))) await publishFile(cachedSource, source, 0o600);

  // Honor explicit toolchain selection without inheriting credentials. When no
  // selection was made, retry the selected default toolchain if full Xcode fails.
  const fullXcode = '/Applications/Xcode.app/Contents/Developer';
  const hasExplicitDeveloperDir = Object.hasOwn(process.env, 'DEVELOPER_DIR');
  const explicit = process.env.DEVELOPER_DIR ?? '';
  const hasFullXcode = (await lstat(fullXcode).catch(() => undefined))?.isDirectory() ?? false;
  const environments: NodeJS.ProcessEnv[] = hasExplicitDeveloperDir ? [{ DEVELOPER_DIR: explicit }] : hasFullXcode ? [{ DEVELOPER_DIR: fullXcode }, {}] : [{}];
  let timedOut = false;
  for (const compilerEnv of environments) {
    const version = await runProcess(XCRUN, ['swiftc', '--version'], undefined, 5_000, 4_096, compilerEnv);
    if (version.timedOut) { timedOut = true; continue; }
    if (version.failed || version.overflow || version.code !== 0 || version.stdout.length === 0) continue;
    const digest = createHash('sha256').update(source).update('\0').update(process.arch).update('\0').update(version.stdout).digest('hex');
    const helper = join(cache, `keychain-${digest}`);
    if (await secureFile(helper, 0o700)) return helper;

    const temporary = `${helper}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
    try {
      const compiled = await runProcess(XCRUN, ['swiftc', cachedSource, '-o', temporary], undefined, COMPILER_TIMEOUT_MS, 4_096, compilerEnv);
      if (compiled.timedOut) { timedOut = true; continue; }
      if (compiled.failed || compiled.overflow || compiled.code !== 0) continue;
      await chmod(temporary, 0o700);
      if (!(await secureFile(temporary, 0o700))) throw failure('unavailable');
      const handle = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, helper); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failure('unavailable'); }
    } finally { await rm(temporary, { force: true }); }
    if (await secureFile(helper, 0o700)) return helper;
  }
  throw failure(timedOut ? 'timeout' : 'compiler-unavailable');
}

function nativeError(value: unknown): CredentialStoreError {
  if (value === 'denied') return failure('denied');
  if (value === 'unavailable') return failure('unavailable');
  if (value === 'invalid') return failure('invalid-state');
  return failure('unavailable');
}

function responseError(response: Record<string, unknown>): CredentialStoreError | undefined {
  if (response.version === 1 && response.ok === false && hasOnlyKeys(response, ['version', 'ok', 'error'])) return nativeError(response.error);
  return undefined;
}

function helperCompiler(agentDir: string): () => Promise<string> {
  let helper: Promise<string> | undefined;
  return async () => {
    if (!helper) {
      const attempt = compileHelper(agentDir);
      helper = attempt;
      attempt.catch(() => { if (helper === attempt) helper = undefined; });
    }
    return helper;
  };
}

function defaultRunner(getHelper: () => Promise<string>): HelperRunner {
  return async request => {
    let input: Buffer;
    try { input = Buffer.from(JSON.stringify(request)); } catch { throw failure('invalid-state'); }
    if (input.length > PROTOCOL_LIMIT) throw failure('invalid-state');
    const executable = await getHelper();
    const result = await runProcess(executable, [], input, HELPER_TIMEOUT_MS, PROTOCOL_LIMIT);
    if (result.timedOut) throw failure('timeout');
    if (result.failed || result.overflow || result.code !== 0) throw failure('unavailable');
    try { return JSON.parse(result.stdout.toString('utf8')) as unknown; }
    catch { throw failure('unavailable'); }
  };
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

function deadline<T, U>(promise: Promise<T>, timeoutMs: number, value: U): Promise<T | U> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(value), timeoutMs);
    promise.then(result => { clearTimeout(timer); resolve(result); }, () => { clearTimeout(timer); resolve(value); });
  });
}

function nativeLock(agentDir: string, getHelper: () => Promise<string>, lockPath: string) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let executable: string;
    try {
      await secureAgentDirectory(agentDir);
      await securePrivateDirectory(join(agentDir, '.harbor-mcp-oauth'));
      executable = await getHelper();
      if (!(await secureFile(executable, 0o700))) throw failure('lock');
    }
    catch (error) { throw error instanceof CredentialStoreError ? error : failure('lock'); }

    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, ['--lock', lockPath], { detached: true, env: {}, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { throw failure('lock'); }
    child.stdin?.on('error', () => undefined);
    const closed = new Promise<number | null>(resolveClose => child.once('close', resolveClose));
    const errored = new Promise<'error'>(resolveError => child.once('error', () => resolveError('error')));
    let onOutput: (chunk: Buffer) => void;
    const ready = new Promise<'ready' | 'invalid'>(resolveReady => {
      let output = Buffer.alloc(0);
      onOutput = (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]);
        if (output.length > LOCK_OUTPUT_LIMIT) resolveReady('invalid');
        else if (output.includes(0x0a)) resolveReady(output.equals(Buffer.from('locked\n')) ? 'ready' : 'invalid');
      };
      child.stdout?.on('data', onOutput);
    });
    let startupTimeout: ReturnType<typeof setTimeout>;
    const startupTimer = new Promise<'timeout'>(resolveTimeout => { startupTimeout = setTimeout(() => resolveTimeout('timeout'), LOCK_STARTUP_TIMEOUT_MS); });
    const started = await Promise.race([ready, errored, closed.then(code => code === 75 ? 'busy' as const : 'closed' as const), startupTimer]);
    clearTimeout(startupTimeout!);
    child.stdout?.removeListener('data', onOutput!);
    child.stdout?.resume();
    if (started !== 'ready') {
      if (started !== 'busy' && started !== 'closed') killProcessGroup(child);
      await deadline(closed, LOCK_CLOSE_TIMEOUT_MS, null);
      throw failure(started === 'busy' ? 'busy' : 'lock');
    }

    let value!: T;
    let callbackError: unknown;
    let callbackFailed = false;
    try { value = await operation(); }
    catch (error) { callbackFailed = true; callbackError = error; }
    child.stdin?.end();
    let code = await deadline(closed, LOCK_CLOSE_TIMEOUT_MS, undefined);
    if (code === undefined) {
      killProcessGroup(child);
      code = await deadline(closed, 1_000, undefined);
    }
    if (callbackFailed) throw callbackError;
    if (code !== 0) throw failure('lock');
    return value;
  };
}

function makeStore(key: string, runner: HelperRunner): OAuthStore {
  if (!KEY.test(key)) throw failure('invalid-key');
  const request = (action: HelperAction, payload?: OAuthState) => runner({ version: 1, action, service: SERVICE, account: key, ...(payload ? { payload } : {}) });
  return {
    async load() {
      let response: unknown;
      try { response = await request('load'); }
      catch (error) { throw error instanceof CredentialStoreError ? error : failure('unavailable'); }
      if (!isRecord(response) || response.version !== 1 || response.ok !== true || typeof response.found !== 'boolean'
        || !hasOnlyKeys(response, response.found ? ['version', 'ok', 'found', 'payload'] : ['version', 'ok', 'found'])) {
        if (isRecord(response)) { const error = responseError(response); if (error) throw error; }
        throw failure('unavailable');
      }
      if (!response.found) return undefined;
      return validateState(response.payload);
    },
    async save(value) {
      const state = validateState(value);
      let response: unknown;
      try { response = await request('save', state); }
      catch (error) { throw error instanceof CredentialStoreError ? error : failure('unavailable'); }
      if (!isRecord(response) || response.version !== 1 || response.ok !== true || !hasOnlyKeys(response, ['version', 'ok'])) {
        if (isRecord(response)) { const error = responseError(response); if (error) throw error; }
        throw failure('unavailable');
      }
    },
    async delete() {
      let response: unknown;
      try { response = await request('delete'); }
      catch (error) { throw error instanceof CredentialStoreError ? error : failure('unavailable'); }
      if (!isRecord(response) || response.version !== 1 || response.ok !== true || !hasOnlyKeys(response, ['version', 'ok'])) {
        if (isRecord(response)) { const error = responseError(response); if (error) throw error; }
        throw failure('unavailable');
      }
    },
  };
}

export function createOAuthStore(agentDir: string, key: string): OAuthStore | undefined {
  if (!KEY.test(key)) throw failure('invalid-key');
  if (process.platform !== 'darwin') return undefined;
  const resolvedAgentDir = resolve(agentDir);
  const getHelper = helperCompiler(resolvedAgentDir);
  const store = makeStore(key, defaultRunner(getHelper));
  store.withLock = nativeLock(resolvedAgentDir, getHelper, join(resolvedAgentDir, '.harbor-mcp-oauth', `${key}.lock`));
  return store;
}

/** Injectable wire-protocol seam for deterministic tests; it never invokes the native helper. */
export const credentialStoreTest = { createOAuthStore: (key: string, runner: HelperRunner): OAuthStore => makeStore(key, runner) };
