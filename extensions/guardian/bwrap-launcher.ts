// Ported from openai/codex codex-rs/sandboxing/src/bwrap.rs, codex-rs/linux-sandbox/src/{launcher,bundled_bwrap,
// linux_run_main}.rs and codex-rs/install-context/src/lib.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// Codex prefers the first bubblewrap on PATH that the sandboxed process cannot replace, and falls back to the copy
// bundled with Codex. Guardian finds that copy in the Codex install on PATH; Codex additionally checks it against a
// SHA-256 digest compiled into its build, which Guardian cannot know, so it relies on the same replaceability checks.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { killProcessGroup, raceAbort, runBounded } from './review/process.ts';
import { pathStartsWith, type WritableRoot } from './seatbelt.ts';

export const MISSING_BWRAP_WARNING = 'Guardian could not find bubblewrap 0.8 or newer on PATH. Install bubblewrap with your OS package manager. '
  + 'Guardian uses the bubblewrap bundled with Codex in the meantime.';
export const NO_BWRAP_WARNING = 'Guardian could not find bubblewrap 0.8 or newer on PATH or in a Codex install, so nothing is sandboxed and every '
  + 'command needs approval. Install bubblewrap with your OS package manager.';
export const USER_NAMESPACE_WARNING = "Guardian's Linux sandbox uses bubblewrap and needs access to create user namespaces, so nothing is sandboxed "
  + 'and every command needs approval until it can.';
export const WSL1_BWRAP_WARNING = "Guardian's Linux sandbox uses bubblewrap, which is not supported on WSL1 because WSL1 cannot create the required "
  + 'user namespaces, so every command needs approval. Use WSL2 for sandboxed shell commands.';

const USER_NAMESPACE_FAILURES = [
  'loopback: Failed RTM_NEWADDR',
  'loopback: Failed RTM_NEWLINK',
  'setting up uid map: Permission denied',
  'No permissions to create a new namespace',
  // Older bubblewrap releases word it without the article.
  'No permissions to create new namespace',
];
const SYSTEM_BWRAP_PROBE_TIMEOUT_MS = 500;
const SYSTEM_BWRAP_PROBE_STDERR_LIMIT_BYTES = 64 * 1024;

export interface BwrapLauncher {
  program: string;
  source: 'system' | 'codex';
}

const canonicalOr = (path: string) => { try { return realpathSync(path); } catch { return path; } };

export function procVersionIndicatesWsl1(procVersion: string): boolean {
  const lower = procVersion.toLowerCase();
  for (const match of lower.matchAll(/wsl(\d*)/g)) {
    if (match[1]) return Number(match[1]) === 1;
  }
  return lower.includes('microsoft') && !lower.includes('microsoft-standard');
}

export function isWsl1(): boolean {
  try { return procVersionIndicatesWsl1(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

/** Owners can chmod a read-only path before writing it; others are asked of the kernel, including ACLs. */
function currentUserCanModify(path: string): boolean {
  let owner: number;
  try { owner = statSync(path).uid; } catch { return true; }
  if (owner === process.geteuid?.()) return true;
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch (error) {
    // Unknown errors must not turn an unverified candidate into a trusted one.
    return !['EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every executable `program` on the search path, in order, as `which` finds them. */
function whichAll(program: string, searchPaths: readonly string[], cwd: string): string[] {
  return searchPaths.filter(Boolean).map(dir => resolve(cwd, dir, program)).filter(isExecutableFile);
}

/**
 * Whether the sandboxed process could replace `path`: it lies under a writable root (outside its read-only
 * carveouts) and the user can modify it, or a writable, modifiable ancestor could rename it away.
 */
function replaceableBySandbox(path: string, cwd: string, writableRoots: readonly WritableRoot[]): boolean {
  const roots = writableRoots.map(({ root, readOnlySubpaths }) => {
    const canonical = canonicalOr(root);
    return { root: canonical, readOnlySubpaths: readOnlySubpaths.map(subpath => pathStartsWith(subpath, root) ? join(canonical, subpath.slice(root.length)) : subpath) };
  });
  const policyCanWrite = (candidate: string) => roots.some(({ root, readOnlySubpaths }) =>
    pathStartsWith(candidate, root) && !readOnlySubpaths.some(subpath => pathStartsWith(candidate, subpath)));
  const canonicalCwd = canonicalOr(cwd);
  if (canonicalCwd !== '/' && pathStartsWith(path, canonicalCwd)) return true;
  if (policyCanWrite(path) && currentUserCanModify(path)) return true;
  for (let component = path; component !== '/'; component = dirname(component)) {
    const parent = dirname(component);
    // Read-only carveouts are bind mounts and cannot themselves be renamed; a mutable ancestor still could.
    const isReadOnlyMount = roots.some(root => root.readOnlySubpaths.includes(component));
    if (policyCanWrite(parent) && !isReadOnlyMount && currentUserCanModify(parent)) return true;
  }
  return false;
}

/**
 * The first canonical executable on the search path for use before sandbox construction, skipping candidates under
 * a non-root cwd and candidates the sandboxed process could modify or replace.
 */
export function findExecutableInSearchPaths(program: string, searchPaths: readonly string[], cwd: string, writableRoots: readonly WritableRoot[]): string | undefined {
  for (const candidate of whichAll(program, searchPaths, cwd)) {
    let path: string;
    try { path = realpathSync(candidate); } catch { continue; }
    if (!replaceableBySandbox(path, cwd, writableRoots)) return path;
  }
  return undefined;
}

export interface BwrapCapabilities {
  supportsArgv0: boolean;
  supportsPerms: boolean;
}

const capabilityCache = new Map<string, BwrapCapabilities | undefined>();
const capabilityProbes = new Map<string, { controller: AbortController; result: Promise<BwrapCapabilities | undefined>; waiters: number }>();

/**
 * What `bwrap --help` lists. Codex requires `--as-pid-1` (bubblewrap 0.8) and `--perms`; Guardian installs seccomp
 * with `--seccomp` instead of re-executing a helper, so it never needs `--argv0`.
 */
export async function bwrapCapabilities(path: string, signal?: AbortSignal): Promise<BwrapCapabilities | undefined> {
  signal?.throwIfAborted();
  let key: string;
  try { const info = statSync(path); key = `${path}:${info.ino}:${info.mtimeMs}:${info.size}`; } catch { return undefined; }
  if (capabilityCache.has(key)) return capabilityCache.get(key);
  let probe = capabilityProbes.get(key);
  if (!probe) {
    const controller = new AbortController();
    const result = runBounded(path, ['--help'], { cwd: '/', signal: controller.signal, timeoutMs: 5_000, maxBytes: 256 * 1024 }).then(result => {
      const help = `${result.stdout}\n${result.stderr}`;
      const capabilities = result.spawnError || result.timedOut || result.aborted || !help.includes('--as-pid-1')
        ? undefined : { supportsArgv0: help.includes('--argv0'), supportsPerms: help.includes('--perms') };
      if (!controller.signal.aborted) capabilityCache.set(key, capabilities);
      return capabilities;
    }).finally(() => { if (capabilityProbes.get(key)?.controller === controller) capabilityProbes.delete(key); });
    probe = { controller, result, waiters: 0 };
    capabilityProbes.set(key, probe);
  }
  probe.waiters++;
  try {
    return await (signal ? raceAbort(probe.result, signal) : probe.result);
  } finally {
    if (--probe.waiters === 0 && capabilityProbes.get(key) === probe) {
      capabilityProbes.delete(key);
      probe.controller.abort();
    }
  }
}

export async function findSystemBwrap(searchPaths: readonly string[], cwd: string, writableRoots: readonly WritableRoot[], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const path = findExecutableInSearchPaths('bwrap', searchPaths, cwd, writableRoots);
  return path && (await bwrapCapabilities(path, signal))?.supportsPerms ? path : undefined;
}

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
};
const TARGET_BY_ARCH: Partial<Record<NodeJS.Architecture, string>> = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' };

/** The native Codex executable behind `codex` on PATH, following the npm, pnpm and bun `codex.js` shim. */
export function codexExecutable(searchPaths: readonly string[], cwd: string, arch: NodeJS.Architecture = process.arch): string | undefined {
  const launcher = whichAll('codex', searchPaths, cwd)[0];
  if (!launcher) return undefined;
  let real: string;
  try { real = realpathSync(launcher); } catch { return undefined; }
  if (!real.endsWith('.js')) return real;
  const target = TARGET_BY_ARCH[arch];
  if (!target) return undefined;
  let vendorRoot: string;
  try {
    vendorRoot = join(dirname(createRequire(real).resolve(`${PLATFORM_PACKAGE_BY_TARGET[target]}/package.json`)), 'vendor');
  } catch {
    vendorRoot = join(dirname(real), '..', 'vendor');
  }
  const executable = join(vendorRoot, target, 'bin', 'codex');
  try { return realpathSync(executable); } catch { return undefined; }
}

/** Where Codex looks for its bundled bubblewrap, relative to its executable: package layout, standalone, then legacy. */
export function bundledBwrapCandidates(exe: string, codexHome: string): string[] {
  const exeDir = dirname(exe);
  const candidates: string[] = [];
  const packageDir = basename(exeDir) === 'bin' || basename(exeDir) === 'codex-resources' ? dirname(exeDir) : undefined;
  const hasPackageLayout = packageDir !== undefined && (() => { try { return statSync(join(packageDir, 'codex-package.json')).isFile(); } catch { return false; } })();
  if (hasPackageLayout) candidates.push(join(packageDir, 'codex-resources', 'bwrap'));
  const releaseDir = hasPackageLayout ? packageDir : exeDir;
  if (pathStartsWith(releaseDir, join(canonicalOr(codexHome), 'packages', 'standalone', 'releases'))) candidates.push(join(releaseDir, 'codex-resources', 'bwrap'));
  candidates.push(join(exeDir, 'codex-resources', 'bwrap'), join(dirname(exeDir), 'codex-resources', 'bwrap'), join(exeDir, 'bwrap'));
  return [...new Set(candidates)];
}

export function findCodexBundledBwrap(searchPaths: readonly string[], cwd: string, writableRoots: readonly WritableRoot[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = codexExecutable(searchPaths, cwd);
  if (!exe) return undefined;
  const codexHome = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(homedir(), '.codex');
  for (const candidate of bundledBwrapCandidates(exe, codexHome)) {
    if (!isExecutableFile(candidate)) continue;
    const path = canonicalOr(candidate);
    if (!replaceableBySandbox(path, cwd, writableRoots)) return path;
  }
  return undefined;
}

/**
 * System bubblewrap first, then the copy bundled with the Codex install on PATH. Codex's helper runs in the command's
 * cwd, so relative PATH entries and the cwd exclusion use the command's cwd here.
 */
export async function findBwrapLauncher(cwd: string, writableRoots: readonly WritableRoot[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<BwrapLauncher | undefined> {
  const searchPaths = (env.PATH ?? '').split(delimiter);
  const system = await findSystemBwrap(searchPaths, cwd, writableRoots, signal);
  signal?.throwIfAborted();
  if (system) return { program: system, source: 'system' };
  const bundled = findCodexBundledBwrap(searchPaths, cwd, writableRoots, env);
  return bundled ? { program: bundled, source: 'codex' } : undefined;
}

/** False only when bubblewrap reports that it cannot create the namespaces the sandbox needs. */
export function bwrapHasUserNamespaceAccess(program: string, timeoutMs = SYSTEM_BWRAP_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolvePromise => {
    let child;
    try {
      child = spawn(program, ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    } catch {
      return resolvePromise(true);
    }
    let stderr = '';
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.destroy();
      resolvePromise(value);
    };
    // A probe that hangs is not a namespace failure; descendants holding stderr open must not delay the answer.
    const timer = setTimeout(() => {
      killProcessGroup(child);
      settle(true);
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < SYSTEM_BWRAP_PROBE_STDERR_LIMIT_BYTES) stderr += chunk.toString(); });
    child.on('error', () => settle(true));
    child.on('exit', code => setImmediate(() => settle(code === 0 || !USER_NAMESPACE_FAILURES.some(failure => stderr.includes(failure)))));
  });
}

export function launcherSummary(launcher: BwrapLauncher): string {
  return `bubblewrap ${launcher.program}${launcher.source === 'codex' ? ' (bundled with Codex)' : ''}`;
}
