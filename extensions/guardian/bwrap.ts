// Ported from openai/codex codex-rs/linux-sandbox/src/{bwrap,linux_run_main}.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. Bubblewrap mounts the filesystem read-only, binds the writable roots back writable, and
// re-applies read-only protection to sensitive subpaths such as `.git`, `.agents` and `.codex` inside them.
// Guardian's policies always read the whole filesystem, so the split-policy readable roots, deny-read globs, WSL masks
// and Codex's app-server socket masks are omitted.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathStartsWith, PROTECTED_METADATA_PATH_NAMES, SandboxPreparationError, type WritableRoot } from './seatbelt.ts';
import { existingTarget, missingTarget, type SyntheticMountTarget } from './synthetic-mounts.ts';

/** Linux system paths readable by the `/proc` mount preflight's minimal filesystem view. */
export const LINUX_PLATFORM_DEFAULT_READ_ROOTS = ['/bin', '/sbin', '/usr', '/etc', '/lib', '/lib64', '/nix/store', '/run/current-system/sw'];

/** The first descriptor bubblewrap reads `--ro-bind-data` contents from; each one carries an empty file. */
export const FIRST_BIND_DATA_FD = 3;

export interface BwrapOptions {
  /** Mount a fresh `/proc`; turned off when the preflight shows the host forbids it. */
  mountProc: boolean;
  /** `isolated` unshares the network namespace; `full-access` keeps the host's. */
  networkMode: 'full-access' | 'isolated';
  /** Codex's synthetic mount registry, kept read-only wherever a writable bind exposes it. */
  registryRoot: string;
}

export interface BwrapArgs {
  /** Bubblewrap's arguments, without its program name. */
  args: string[];
  /** How many empty-file descriptors the arguments use, numbered from FIRST_BIND_DATA_FD. */
  bindDataFds: number;
  syntheticMountTargets: SyntheticMountTarget[];
}

const isProtectedMetadataName = (name: string) => (PROTECTED_METADATA_PATH_NAMES as readonly string[]).includes(name);
const pathDepth = (path: string) => path.split('/').filter(Boolean).length;
const byDepth = (left: string, right: string) => pathDepth(left) - pathDepth(right);
const isWithinAllowedWritePaths = (path: string, allowed: readonly string[]) => allowed.some(root => pathStartsWith(path, root));

function lstatOrUndefined(path: string) {
  try { return lstatSync(path, { bigint: true }); } catch { return undefined; }
}

/** Prefixes of an absolute path, from the first component down to the path itself. */
function componentPrefixes(path: string): string[] {
  const prefixes: string[] = [];
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current = `${current}/${part}`;
    prefixes.push(current);
  }
  return prefixes;
}

/** The fully resolved target, only when some component of `path` is a symlink. */
export function canonicalTargetIfSymlinkedPath(path: string): string | undefined {
  for (const current of componentPrefixes(path)) {
    const stats = lstatOrUndefined(current);
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) {
      let target: string;
      try { target = realpathSync(path); } catch { return undefined; }
      return target === path ? undefined : target;
    }
  }
  return undefined;
}

function remapPathsForSymlinkTarget(paths: string[], root: string, target: string): string[] {
  return paths.map(path => pathStartsWith(path, root) ? join(target, relative(root, path)) : path);
}

/**
 * The first symlink component under a writable root. The sandboxed process can replace such a link, so any mount
 * based on its current target would race a path the process controls.
 */
function firstWritableSymlinkComponentInPath(path: string, allowed: readonly string[]): string | undefined {
  for (const current of componentPrefixes(path)) {
    const stats = lstatOrUndefined(current);
    if (!stats) break;
    if (stats.isSymbolicLink() && isWithinAllowedWritePaths(current, allowed)) return current;
  }
  return undefined;
}

/** Masking the first missing component prevents the sandboxed process from creating the protected hierarchy. */
function findFirstNonExistentComponent(path: string): string | undefined {
  return componentPrefixes(path).find(current => !existsSync(current));
}

function directoryIsEmpty(path: string): boolean {
  try { return readdirSync(path).length === 0; } catch { return false; }
}

function appendEmptyFileBindDataArgs(bwrap: BwrapArgs, path: string): void {
  // Bubblewrap consumes and closes the descriptor for each bind-data mount.
  bwrap.args.push('--ro-bind-data', String(FIRST_BIND_DATA_FD + bwrap.bindDataFds++), path);
}

function appendEmptyDirectoryArgs(bwrap: BwrapArgs, path: string): void {
  bwrap.args.push('--perms', '555', '--tmpfs', path, '--remount-ro', path);
}

function appendMissingReadOnlySubpathArgs(bwrap: BwrapArgs, path: string): void {
  if (isProtectedMetadataName(basename(path))) {
    appendEmptyDirectoryArgs(bwrap, path);
    bwrap.syntheticMountTargets.push(missingTarget(path, 'empty-directory'));
    return;
  }
  appendEmptyFileBindDataArgs(bwrap, path);
  bwrap.syntheticMountTargets.push(missingTarget(path, 'empty-file'));
}

/** Mounts for a read-only path, after writable-symlink validation. */
function appendReadOnlySubpathArgs(bwrap: BwrapArgs, subpath: string, allowed: readonly string[]): void {
  if (isProtectedMetadataName(basename(subpath)) && isWithinAllowedWritePaths(subpath, allowed)) {
    // Another concurrent sandbox can leave an empty mount target at a missing metadata path. Treat it like the
    // missing case instead of binding that transient host path as the stable source.
    const stats = lstatOrUndefined(subpath);
    if (stats?.isFile() && stats.size === 0n) {
      appendEmptyFileBindDataArgs(bwrap, subpath);
      bwrap.syntheticMountTargets.push(existingTarget(subpath, 'empty-file', stats));
      return;
    }
    if (stats?.isDirectory() && directoryIsEmpty(subpath)) {
      appendEmptyDirectoryArgs(bwrap, subpath);
      bwrap.syntheticMountTargets.push(existingTarget(subpath, 'empty-directory', stats));
      return;
    }
  }
  if (!existsSync(subpath)) {
    const firstMissing = findFirstNonExistentComponent(subpath);
    if (firstMissing && isWithinAllowedWritePaths(firstMissing, allowed)) appendMissingReadOnlySubpathArgs(bwrap, firstMissing);
    return;
  }
  if (isWithinAllowedWritePaths(subpath, allowed)) bwrap.args.push('--ro-bind', subpath, subpath);
}

/**
 * The filesystem mounts, in an order that matters: a read-only `/` with a minimal `/dev`, then each writable root
 * from shallowest to deepest, each followed by its read-only carveouts so protected subpaths win.
 */
export function createFilesystemArgs(writableRoots: readonly WritableRoot[], options: Pick<BwrapOptions, 'registryRoot'>): BwrapArgs {
  // Bubblewrap requires bind mount targets to exist, so missing writable roots are skipped.
  const roots = writableRoots.filter(root => existsSync(root.root));
  // `--dev /dev` creates the standard minimal nodes (null, zero, full, random, urandom, tty) before writable binds.
  const bwrap: BwrapArgs = { args: ['--ro-bind', '/', '/', '--dev', '/dev'], bindDataFds: 0, syntheticMountTargets: [] };
  const allowedWritePaths = roots.flatMap(({ root }) => {
    const target = canonicalTargetIfSymlinkedPath(root);
    return target ? [root, target] : [root];
  });
  const sortedRoots = [...roots].sort((left, right) => byDepth(left.root, right.root));
  const bindsFileSystemRoot = sortedRoots.some(({ root }) => root === '/');

  for (const writableRoot of sortedRoots) {
    const root = writableRoot.root;
    const symlinkTarget = canonicalTargetIfSymlinkedPath(root);
    const mountRoot = symlinkTarget ?? root;
    // Rebinding a root alias would also undo masks already applied to `/`.
    if (!(bindsFileSystemRoot && root !== '/' && mountRoot === '/')) {
      bwrap.args.push('--bind', mountRoot, mountRoot);
      // The root bind shadows the earlier device tree and applies nodev; recreate only the standard devices.
      if (mountRoot === '/') bwrap.args.push('--dev', '/dev', '--bind-try', '/dev/shm', '/dev/shm');
    }

    let readOnlySubpaths = [...writableRoot.readOnlySubpaths];
    // Mounts that belong to a deeper writable root are applied after that root is bound, but still validated here.
    let deferred = readOnlySubpaths.filter(path => sortedRoots.some(nested => nested.root !== root && pathStartsWith(nested.root, root)
      && pathStartsWith(path, nested.root) && nested.readOnlySubpaths.includes(path)));
    for (const name of PROTECTED_METADATA_PATH_NAMES) {
      const path = join(root, name);
      if (!readOnlySubpaths.includes(path)) readOnlySubpaths.push(path);
    }
    if (symlinkTarget) {
      readOnlySubpaths = remapPathsForSymlinkTarget(readOnlySubpaths, root, symlinkTarget);
      deferred = remapPathsForSymlinkTarget(deferred, root, symlinkTarget);
    }
    readOnlySubpaths.sort(byDepth);
    for (const subpath of readOnlySubpaths) {
      const symlink = firstWritableSymlinkComponentInPath(subpath, allowedWritePaths);
      // Binding the symlink's current target would only protect a startup-time snapshot.
      if (symlink) throw new SandboxPreparationError(`cannot enforce sandbox read-only path ${subpath} because it crosses writable symlink ${symlink}`);
      if (deferred.includes(subpath)) continue;
      appendReadOnlySubpathArgs(bwrap, subpath, allowedWritePaths);
    }

    // Keep the placeholder registry read-only wherever a writable bind exposes it.
    const registryMount = pathStartsWith(options.registryRoot, mountRoot) ? options.registryRoot
      : pathStartsWith(mountRoot, options.registryRoot) ? mountRoot : undefined;
    if (registryMount) {
      mkdirSync(options.registryRoot, { recursive: true });
      bwrap.args.push('--ro-bind', registryMount, registryMount);
    }
  }
  return bwrap;
}

/** Bubblewrap's arguments for `command` with `writableRoots`, everything after its program name. */
export function createBwrapCommandArgs(command: readonly string[], writableRoots: readonly WritableRoot[], commandCwd: string, options: BwrapOptions): BwrapArgs {
  const filesystem = createFilesystemArgs(writableRoots, options);
  const args = ['--new-session', '--die-with-parent', ...filesystem.args];
  // Request a user namespace explicitly; bubblewrap skips its automatic one when the caller runs as uid 0.
  args.push('--unshare-user', '--unshare-pid', '--unshare-ipc');
  if (options.networkMode === 'isolated') args.push('--unshare-net');
  if (options.mountProc) args.push('--proc', '/proc');
  // A symlinked cwd can disappear once only canonical roots are mounted; enter the canonical path explicitly.
  const canonicalCwd = (() => { try { return realpathSync(commandCwd); } catch { return commandCwd; } })();
  if (canonicalCwd !== commandCwd) args.push('--chdir', canonicalCwd);
  args.push('--cap-drop', 'ALL', '--', ...command);
  return { ...filesystem, args };
}

/** The `/proc` mount preflight: `true` in a minimal filesystem view with a fresh `/proc`. */
export function createProcPreflightArgs(networkMode: BwrapOptions['networkMode']): string[] {
  const readRoots = [...LINUX_PLATFORM_DEFAULT_READ_ROOTS].sort().filter(path => existsSync(path));
  const trueCommand = ['/usr/bin/true', '/bin/true'].find(path => existsSync(path)) ?? 'true';
  return [
    '--new-session', '--die-with-parent', '--tmpfs', '/', '--dev', '/dev', ...readRoots.flatMap(root => ['--ro-bind', root, root]),
    '--unshare-user', '--unshare-pid', '--unshare-ipc', ...(networkMode === 'isolated' ? ['--unshare-net'] : []),
    '--proc', '/proc', '--cap-drop', 'ALL', '--', trueCommand,
  ];
}

export function isProcMountFailure(stderr: string): boolean {
  return stderr.includes("Can't mount proc") && stderr.includes('/newroot/proc')
    && (stderr.includes('Invalid argument') || stderr.includes('Operation not permitted') || stderr.includes('Permission denied'));
}

/** Codex runs the command as PID 1 of its namespace when it creates one, instead of bubblewrap's reaper. */
export function withAsPid1(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  const flags = separator === -1 ? args : args.slice(0, separator);
  return flags.includes('--unshare-pid') ? ['--as-pid-1', ...args] : [...args];
}

/** Inserts bubblewrap options just before the command separator. */
export function withOptionsBeforeCommand(args: readonly string[], options: readonly string[]): string[] {
  const separator = args.indexOf('--');
  if (separator === -1) throw new Error("bubblewrap argv is missing command separator '--'");
  return [...args.slice(0, separator), ...options, ...args.slice(separator)];
}

