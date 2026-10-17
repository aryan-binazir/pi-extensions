// The platform sandbox Guardian runs commands in, as Codex selects it in openai/codex codex-rs/sandboxing/src/
// manager.rs @ ce0323f (Apache-2.0; see docs/licenses/README.md): Seatbelt on macOS, and on Linux bubblewrap for the
// filesystem with a seccomp filter for the network. Without one, nothing is confined and every command is reviewed.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import {
  type BwrapLauncher, bwrapHasUserNamespaceAccess, findBwrapLauncher, isWsl1, launcherSummary, MISSING_BWRAP_WARNING, NO_BWRAP_WARNING,
  USER_NAMESPACE_WARNING, WSL1_BWRAP_WARNING,
} from './bwrap-launcher.ts';
import { createBwrapCommandArgs, createProcPreflightArgs, FIRST_BIND_DATA_FD, isProcMountFailure, withAsPid1, withOptionsBeforeCommand } from './bwrap.ts';
import { killProcessGroup } from './review/process.ts';
import { networkSeccompMode, seccompProgram, seccompSupported } from './seccomp.ts';
import {
  createSeatbeltCommandArgs, MACOS_PATH_TO_SEATBELT_EXECUTABLE, SandboxPreparationError, type SandboxPolicy, sandboxEnv as seatbeltEnv,
  type WritableRoot, workspaceWriteRoots,
} from './seatbelt.ts';
import { cleanupSyntheticMountTargets, registerSyntheticMountTargets, syntheticMountRegistryRoot } from './synthetic-mounts.ts';

export type SandboxKind = 'seatbelt' | 'bubblewrap';

export type SandboxedChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

export interface SandboxedProcess {
  child: SandboxedChild;
  /** Settles once the process has exited and bubblewrap's mount placeholders are gone. */
  finished: Promise<void>;
}

export interface SpawnSandboxedOptions {
  cwd: string;
  /** The command's environment, before the sandbox adds its own variables. */
  env: NodeJS.ProcessEnv;
  stdin: 'pipe' | 'ignore';
}

export interface PlatformSandbox {
  readonly kind: SandboxKind;
  /** What enforces the sandbox, for `/guardian status`. */
  readonly summary: string;
  /** Starts `command` in its own process group under `policy`; rejects when the policy cannot be enforced. */
  spawn(command: readonly string[], policy: SandboxPolicy, options: SpawnSandboxedOptions): Promise<SandboxedProcess>;
}

export interface SandboxDetection {
  sandbox?: PlatformSandbox;
  /** Shown once at session start, as Codex shows its startup sandbox warnings. */
  warning?: string;
}

const SIGSYS_EXIT_CODE = 128 + 31;
const PREFLIGHT_TIMEOUT_MS = 10_000;

/** Environment Codex sets for sandboxed commands: the backend on macOS, and whether the network is disabled. */
export function sandboxEnv(kind: SandboxKind, policy: SandboxPolicy): Record<string, string> {
  if (kind === 'seatbelt') return seatbeltEnv(policy);
  return policy.networkAccess ? {} : { CODEX_SANDBOX_NETWORK_DISABLED: '1' };
}

/**
 * Codex's denial heuristic: a failure whose output names a sandbox restriction, or on Linux a process killed by
 * SIGSYS, which seccomp delivers.
 */
const SANDBOX_DENIED_KEYWORDS = ['operation not permitted', 'permission denied', 'read-only file system', 'seccomp', 'sandbox', 'landlock', 'failed to write file'];
export function isLikelySandboxDenied(exitCode: number, output: string, kind: SandboxKind | undefined): boolean {
  if (exitCode === 0) return false;
  const lower = output.toLowerCase();
  if (SANDBOX_DENIED_KEYWORDS.some(keyword => lower.includes(keyword))) return true;
  if ([2, 126, 127].includes(exitCode)) return false;
  return kind === 'bubblewrap' && exitCode === SIGSYS_EXIT_CODE;
}

function exited(child: SandboxedChild): Promise<void> {
  return new Promise(resolve => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}

export const seatbeltSandbox: PlatformSandbox = {
  kind: 'seatbelt',
  summary: 'Seatbelt',
  async spawn(command, policy, { cwd, env, stdin }) {
    const environment = { ...env, ...sandboxEnv('seatbelt', policy) };
    const args = createSeatbeltCommandArgs(command, policy, cwd, environment);
    const child = spawn(MACOS_PATH_TO_SEATBELT_EXECUTABLE, args, { cwd, env: environment, detached: true, stdio: [stdin, 'pipe', 'pipe'] }) as SandboxedChild;
    return { child, finished: exited(child) };
  },
};

const procMountSupport = new Map<string, Promise<boolean>>();

/**
 * Whether bubblewrap may mount a fresh `/proc` here; some containers forbid it, and Codex then runs without one.
 * Codex probes before every command; Guardian probes once per bubblewrap and network mode.
 */
function procMountSupported(program: string, networkMode: 'full-access' | 'isolated'): Promise<boolean> {
  const key = `${program}\0${networkMode}`;
  let supported = procMountSupport.get(key);
  if (!supported) {
    supported = new Promise(resolve => {
      const child = spawn(program, withAsPid1(createProcPreflightArgs(networkMode)), { cwd: '/', detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => killProcessGroup(child), PREFLIGHT_TIMEOUT_MS);
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', () => { clearTimeout(timer); resolve(true); });
      child.on('close', () => { clearTimeout(timer); resolve(!isProcMountFailure(stderr)); });
    });
    procMountSupport.set(key, supported);
  }
  return supported;
}

export function bubblewrapSandbox(detected: BwrapLauncher): PlatformSandbox {
  return {
    kind: 'bubblewrap',
    summary: launcherSummary(detected),
    async spawn(command, policy, { cwd, env, stdin }) {
      const environment = { ...env, ...sandboxEnv('bubblewrap', policy) };
      const roots = policy.mode === 'workspace-write' ? workspaceWriteRoots(policy, cwd, environment) : [];
      // Resolved per command, as Codex does: a bubblewrap the command's writable roots could replace is never used.
      const launcher = findBwrapLauncher(cwd, roots);
      if (!launcher) throw new SandboxPreparationError(`bubblewrap is unavailable for ${cwd}: no trusted bwrap was found on PATH or in a Codex install`);
      const networkMode = policy.networkAccess ? 'full-access' : 'isolated';
      const registryRoot = syntheticMountRegistryRoot();
      const built = createBwrapCommandArgs(command, roots, cwd, { mountProc: await procMountSupported(launcher.program, networkMode), networkMode, registryRoot });
      const seccompFd = FIRST_BIND_DATA_FD + built.bindDataFds;
      const args = withAsPid1(withOptionsBeforeCommand(built.args, ['--seccomp', String(seccompFd)]));
      const filter = seccompProgram(networkSeccompMode(policy.networkAccess));

      const registrations = await registerSyntheticMountTargets(built.syntheticMountTargets, registryRoot);
      const emptyFiles: number[] = [];
      let child: SandboxedChild;
      try {
        for (let index = 0; index < built.bindDataFds; index++) emptyFiles.push(openSync('/dev/null', 'r'));
        child = spawn(launcher.program, args, { cwd, env: environment, detached: true, stdio: [stdin, 'pipe', 'pipe', ...emptyFiles, 'pipe'] }) as SandboxedChild;
      } catch (error) {
        await cleanupSyntheticMountTargets(registrations, registryRoot);
        throw error;
      } finally {
        for (const fd of emptyFiles) closeSync(fd);
      }
      // Bubblewrap reads the filter to EOF before it builds the sandbox. A launcher that failed to start has no pipe.
      const seccomp = child.stdio[seccompFd] as Writable | null;
      seccomp?.on('error', () => {});
      seccomp?.end(filter);
      // A placeholder left behind is harmless to the command's result, so cleanup failures do not fail the call.
      const finished = exited(child).then(() => cleanupSyntheticMountTargets(registrations, registryRoot)).catch(() => {});
      return { child, finished };
    },
  };
}

async function detect(cwd: string, writableRoots: readonly WritableRoot[]): Promise<SandboxDetection> {
  if (process.platform === 'darwin') return existsSync(MACOS_PATH_TO_SEATBELT_EXECUTABLE) ? { sandbox: seatbeltSandbox } : {};
  if (process.platform !== 'linux') return {};
  if (isWsl1()) return { warning: WSL1_BWRAP_WARNING };
  if (!seccompSupported()) return { warning: `Guardian has no seccomp filter for ${process.arch}, so nothing is sandboxed and every command needs approval.` };
  const launcher = findBwrapLauncher(cwd, writableRoots);
  if (!launcher) return { warning: NO_BWRAP_WARNING };
  if (!(await bwrapHasUserNamespaceAccess(launcher.program))) return { warning: USER_NAMESPACE_WARNING };
  return { sandbox: bubblewrapSandbox(launcher), ...(launcher.source === 'codex' ? { warning: MISSING_BWRAP_WARNING } : {}) };
}

const detections = new Map<string, Promise<SandboxDetection>>();

/** The sandbox for this platform, detected once per cwd; the footer and Guardian share the answer. */
export function detectPlatformSandbox(cwd = process.cwd(), writableRoots: readonly WritableRoot[] = workspaceWriteRoots({ mode: 'workspace-write', networkAccess: false }, cwd, process.env)): Promise<SandboxDetection> {
  let detection = detections.get(cwd);
  if (!detection) {
    detection = detect(cwd, writableRoots);
    detections.set(cwd, detection);
  }
  return detection;
}
