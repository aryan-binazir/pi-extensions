// Ported from openai/codex codex-rs/linux-sandbox/src/{bwrap,linux_run_main}.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. Bubblewrap creates a missing mount target on the host before it masks it, for example an
// empty `.codex` directory inside a writable workspace, and these are removed once no sandbox still masks them.
// Guardian shares Codex's registry directory, marker format and lock file, so Guardian and Codex sandboxes running
// at the same time see each other's placeholders. Codex takes the lock with flock(2); Node cannot, so Guardian runs
// util-linux's flock(1) for the cross-process part and serializes its own registrations in-process.
import { spawn } from 'node:child_process';
import { type BigIntStats, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SYNTHETIC_MOUNT_MARKER_SYNTHETIC = 'synthetic\n';
const SYNTHETIC_MOUNT_MARKER_EXISTING = 'existing\n';
const FLOCK_CANDIDATES = ['/usr/bin/flock', '/bin/flock'];

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface SyntheticMountTarget {
  path: string;
  kind: 'empty-file' | 'empty-directory';
  /** Set when an empty metadata path already existed, so cleanup never deletes a real file or directory. */
  preExisting?: FileIdentity;
}

export const missingTarget = (path: string, kind: SyntheticMountTarget['kind']): SyntheticMountTarget => ({ path, kind });
export const existingTarget = (path: string, kind: SyntheticMountTarget['kind'], stats: BigIntStats): SyntheticMountTarget =>
  ({ path, kind, preExisting: { dev: stats.dev, ino: stats.ino } });

export function shouldRemoveAfterBwrap(target: SyntheticMountTarget, stats: BigIntStats): boolean {
  if (target.kind === 'empty-file' ? !stats.isFile() || stats.size !== 0n : !stats.isDirectory()) return false;
  return target.preExisting === undefined || target.preExisting.dev !== stats.dev || target.preExisting.ino !== stats.ino;
}

export interface SyntheticMountRegistration {
  target: SyntheticMountTarget;
  markerFile: string;
  markerDir: string;
}

/** `$TMPDIR/codex-bwrap-synthetic-mount-targets-<euid>`, canonicalized, as Codex resolves it. */
export function syntheticMountRegistryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const tempDir = realpathSync(env.TMPDIR || '/tmp');
  const root = join(tempDir, `codex-bwrap-synthetic-mount-targets-${process.geteuid?.() ?? 0}`);
  // A registry symlink can redirect bookkeeping into a writable root that does not overlap TMPDIR, bypassing its
  // read-only mount.
  if (lstatOrUndefined(root)?.isSymbolicLink()) throw new Error(`synthetic mount registry must not be a symlink: ${root}`);
  return root;
}

function lstatOrUndefined(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** FNV-1a over the path bytes, the same marker directory name Codex uses. */
export function hashPath(path: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function processIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function markerDirHasActiveProcessMatching(markerDir: string, matches: (path: string) => boolean): boolean {
  let entries: string[];
  try {
    entries = readdirSync(markerDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const path = join(markerDir, name);
    if (!processIsActive(Number(name))) {
      rmSync(path, { force: true });
      continue;
    }
    if (matches(path)) return true;
  }
  return false;
}

const markerDirHasActiveSyntheticOwner = (markerDir: string) => markerDirHasActiveProcessMatching(markerDir, path => {
  try {
    return readFileSync(path, 'utf8') === SYNTHETIC_MOUNT_MARKER_SYNTHETIC;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
});

/**
 * Codex names each marker after the helper process that owns one sandbox. Guardian runs every sandbox from the Pi
 * process, so one marker per path stands for all of this process's registrations, and records `synthetic` while any
 * of them does.
 */
const ownMarkers = new Map<string, { synthetic: number; existing: number }>();

function writeOwnMarker(markerFile: string): void {
  const owners = ownMarkers.get(markerFile);
  if (!owners || owners.synthetic + owners.existing === 0) {
    ownMarkers.delete(markerFile);
    rmSync(markerFile, { force: true });
    return;
  }
  writeFileSync(markerFile, owners.synthetic > 0 ? SYNTHETIC_MOUNT_MARKER_SYNTHETIC : SYNTHETIC_MOUNT_MARKER_EXISTING);
}

let inProcess: Promise<unknown> = Promise.resolve();

/** Runs `critical` under the registry lock: in-process first, then across processes when flock(1) is installed. */
function withRegistryLock<T>(registryRoot: string, critical: () => T): Promise<T> {
  const run = async () => {
    mkdirSync(registryRoot, { recursive: true });
    const release = await acquireFileLock(join(registryRoot, 'lock'));
    try {
      return critical();
    } finally {
      release();
    }
  };
  const result = inProcess.then(run, run);
  inProcess = result.catch(() => {});
  return result;
}

/** Holds flock(2) on `lockPath` through util-linux's flock(1) until the returned release function runs. */
function acquireFileLock(lockPath: string): Promise<() => void> {
  const flock = FLOCK_CANDIDATES.find(path => existsSync(path));
  if (!flock) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    const child = spawn(flock, ['--exclusive', lockPath, '/bin/sh', '-c', 'echo locked; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const release = () => { child.stdin.end(); };
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.once('data', () => resolve(release));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`could not lock the synthetic mount registry ${lockPath}: ${stderr.trim() || `flock exited ${code}`}`)));
  });
}

export function registerSyntheticMountTargets(targets: readonly SyntheticMountTarget[], registryRoot = syntheticMountRegistryRoot()): Promise<SyntheticMountRegistration[]> {
  if (!targets.length) return Promise.resolve([]);
  return withRegistryLock(registryRoot, () => targets.map(original => {
    const markerDir = join(registryRoot, hashPath(original.path));
    mkdirSync(markerDir, { recursive: true });
    // An empty path that another live sandbox created is that sandbox's placeholder, not a real pre-existing path.
    const target = original.preExisting && markerDirHasActiveSyntheticOwner(markerDir) ? missingTarget(original.path, original.kind) : original;
    const markerFile = join(markerDir, String(process.pid));
    const owners = ownMarkers.get(markerFile) ?? { synthetic: 0, existing: 0 };
    if (target.preExisting) owners.existing++; else owners.synthetic++;
    ownMarkers.set(markerFile, owners);
    writeOwnMarker(markerFile);
    return { target, markerFile, markerDir };
  }));
}

export function cleanupSyntheticMountTargets(registrations: readonly SyntheticMountRegistration[], registryRoot = syntheticMountRegistryRoot()): Promise<void> {
  if (!registrations.length) return Promise.resolve();
  return withRegistryLock(registryRoot, () => {
    for (const { target, markerFile } of [...registrations].reverse()) {
      const owners = ownMarkers.get(markerFile);
      if (owners) {
        if (target.preExisting) owners.existing--; else owners.synthetic--;
        writeOwnMarker(markerFile);
      }
    }
    for (const { target, markerDir } of [...registrations].reverse()) {
      if (markerDirHasActiveProcessMatching(markerDir, () => true)) continue;
      removeSyntheticMountTarget(target);
      try {
        rmdirSync(markerDir);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  });
}

function removeSyntheticMountTarget(target: SyntheticMountTarget): void {
  const stats = lstatOrUndefined(target.path);
  if (!stats || !shouldRemoveAfterBwrap(target, stats)) return;
  try {
    if (target.kind === 'empty-file') unlinkSync(target.path); else rmdirSync(target.path);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}
