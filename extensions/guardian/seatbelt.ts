// Ported from openai/codex codex-rs/sandboxing/src/seatbelt.rs and the legacy workspace-write lowering in
// codex-rs/protocol/src/permissions.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md. The `.sbpl` files are verbatim copies.
// Omitted: the managed network proxy, Unix-socket allowlists, unreadable globs, Codex's app-server socket protection,
// and the symlinked CODEX_HOME opt-out.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MACOS_PATH_TO_SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';
const policyFile = (name: string) => readFileSync(join(import.meta.dirname, 'seatbelt', name), 'utf8');
export const MACOS_SEATBELT_BASE_POLICY = policyFile('seatbelt_base_policy.sbpl');
const MACOS_SEATBELT_NETWORK_POLICY = policyFile('seatbelt_network_policy.sbpl');
const MACOS_SEATBELT_PREFERENCES_POLICY = policyFile('seatbelt_preferences_policy.sbpl');
// System libcurl needs this service for TLS.
const MACOS_SEATBELT_TLS_TRUST_POLICY = '(allow mach-lookup (global-name "com.apple.TrustEvaluationAgent"))\n';

/** Top-level workspace metadata paths that stay protected under writable roots. */
export const PROTECTED_METADATA_PATH_NAMES = ['.git', '.agents', '.codex', '.aws'] as const;

export interface SandboxPolicy {
  mode: 'read-only' | 'workspace-write';
  networkAccess: boolean;
  /** Extra writable roots beyond the cwd, `/tmp`, and `$TMPDIR`. */
  writableRoots?: readonly string[];
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export class SeatbeltPreparationError extends Error {}

/** Environment Codex sets for sandboxed shell commands. */
export function sandboxEnv(policy: SandboxPolicy): Record<string, string> {
  return policy.networkAccess ? { CODEX_SANDBOX: 'seatbelt' } : { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' };
}

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
};
const canonicalOrUndefined = (path: string) => { try { return realpathSync(path); } catch { return undefined; } };

const pathStartsWith = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/** Ancestors of `path`, nearest first, excluding the path itself. */
function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    result.push(current);
    if (current === '/') return result;
  }
}

/** Resolves a top-level alias such as `/tmp -> /private/tmp`; deeper components keep their spelling. */
export function normalizeSystemAliases(path: string): string {
  const [, top] = path.split('/');
  if (!top) return path;
  const topLevel = `/${top}`;
  if (!lstatOrUndefined(topLevel)?.isSymbolicLink()) return path;
  return join(realpathSync(topLevel), path.slice(topLevel.length));
}

function normalizePathForSandbox(path: string): string {
  return canonicalOrUndefined(path) ?? path;
}

/** A user-controlled symlink component; top-level macOS aliases are allowed. */
function nestedSymlinkComponent(path: string): string | undefined {
  return [path, ...ancestors(path)].find(ancestor => dirname(dirname(ancestor)) !== dirname(ancestor) && lstatOrUndefined(ancestor)?.isSymbolicLink());
}

function resolveGitdirFromFile(dotGit: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(dotGit, 'utf8').trim();
  } catch {
    return undefined;
  }
  const colon = contents.indexOf(':');
  if (colon === -1 || contents.slice(0, colon).trim() !== 'gitdir') return undefined;
  const raw = contents.slice(colon + 1).trim();
  if (!raw) return undefined;
  const gitdir = resolve(dirname(dotGit), raw);
  return existsSync(gitdir) ? normalizeSystemAliases(gitdir) : undefined;
}

function defaultReadOnlySubpathsForWritableRoot(root: string, protectMissingDotCodex: boolean): string[] {
  const subpaths: string[] = [];
  const dotGit = join(root, '.git');
  // Covers directory `.git`, worktree/submodule pointer files, and their gitdirs.
  if (isDir(dotGit) || isFile(dotGit)) {
    const gitdir = isFile(dotGit) ? resolveGitdirFromFile(dotGit) : undefined;
    if (gitdir) subpaths.push(gitdir);
    subpaths.push(dotGit);
  }
  if (isDir(join(root, '.agents'))) subpaths.push(join(root, '.agents'));
  // The workspace root's `.codex` stays protected even before it exists, so first-time creation needs approval.
  if (protectMissingDotCodex || isDir(join(root, '.codex'))) subpaths.push(join(root, '.codex'));
  // AWS profiles can select credential helpers that the application executes.
  if (isDir(join(root, '.aws'))) subpaths.push(join(root, '.aws'));
  return dedup(subpaths);
}

function dedup(paths: string[]): string[] {
  return [...new Set(paths)];
}

interface WritableRoot {
  root: string;
  readOnlySubpaths: string[];
}

/** Codex's legacy workspace-write roots with their read-only carveouts, as resolved on macOS. */
function workspaceWriteRoots(policy: SandboxPolicy, cwd: string, env: NodeJS.ProcessEnv): WritableRoot[] {
  const cwdRoot = normalizeSystemAliases(cwd);
  const extraRoots = (policy.writableRoots ?? []).map(root => normalizeSystemAliases(root));
  const tmpdir = env.TMPDIR;
  const writeEntries = [
    cwdRoot,
    ...(!policy.excludeSlashTmp && isDir('/tmp') ? [normalizeSystemAliases('/tmp')] : []),
    ...(!policy.excludeTmpdirEnvVar && tmpdir && isAbsolute(tmpdir) ? [normalizeSystemAliases(tmpdir)] : []),
    ...extraRoots,
  ].map(root => (root.length > 1 ? root.replace(/\/+$/, '') : root));

  // Symbolic project-root metadata entries first, then explicit carveouts in Codex's entry order.
  const nonWriteEntries = PROTECTED_METADATA_PATH_NAMES.map(name => join(cwdRoot, name));
  const explicitPathEntries = new Set<string>();
  const appendExplicit = (path: string) => {
    if (nonWriteEntries.includes(path)) return;
    nonWriteEntries.push(path);
    explicitPathEntries.add(path);
  };
  for (const root of extraRoots) for (const path of defaultReadOnlySubpathsForWritableRoot(root, false)) appendExplicit(path);
  for (const path of defaultReadOnlySubpathsForWritableRoot(cwdRoot, true)) appendExplicit(path);
  for (const root of writeEntries) {
    const dotGit = join(root, '.git');
    const gitdir = isFile(dotGit) ? resolveGitdirFromFile(dotGit) : undefined;
    if (gitdir && !explicitPathEntries.has(gitdir) && !nonWriteEntries.includes(gitdir)) nonWriteEntries.push(gitdir);
  }

  return dedup(writeEntries).map(root => ({
    root,
    readOnlySubpaths: dedup([
      ...defaultReadOnlySubpathsForWritableRoot(root, root === cwdRoot).filter(path => !explicitPathEntries.has(path)),
      ...nonWriteEntries.filter(path => path !== root && pathStartsWith(path, root)),
    ]),
  }));
}

/** `regex_lite::escape`. */
export function seatbeltRegexEscape(text: string): string {
  return text.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&');
}

function protectedMetadataNameRegex(root: string, name: string): string {
  const trimmed = root.length > 1 ? root.replace(/\/+$/, '') : root;
  const escapedRoot = seatbeltRegexEscape(trimmed), escapedName = seatbeltRegexEscape(name);
  return escapedRoot === '/' ? `^/${escapedName}(/.*)?$` : `^${escapedRoot}/${escapedName}(/.*)?$`;
}

function normalizeWritableRoot(root: string): { path: string; literal: boolean } {
  const symlink = nestedSymlinkComponent(root);
  if (symlink) {
    throw new SeatbeltPreparationError(`writable root ${root} contains symlink component ${symlink}; symlinked writable roots are not supported.`);
  }
  const normalized = normalizeSystemAliases(root);
  const metadata = lstatOrUndefined(normalized);
  return { path: normalized, literal: metadata !== undefined && !metadata.isDirectory() };
}

function buildWritePolicy(roots: WritableRoot[]): { policy: string; params: [string, string][] } {
  const components: string[] = [], rootAnchorDenies: string[] = [], params: [string, string][] = [];
  roots.forEach((writableRoot, index) => {
    const { path: root, literal } = normalizeWritableRoot(writableRoot.root);
    const rootParam = `WRITABLE_ROOT_${index}`;
    params.push([rootParam, root]);
    // A sandboxed process must not replace an authority boundary reused to build the next policy.
    rootAnchorDenies.push(`(deny file-write-unlink (require-all (literal (param "${rootParam}")) (vnode-type DIRECTORY)))`);
    const requireParts = [literal ? `(literal (param "${rootParam}"))` : `(subpath (param "${rootParam}"))`];
    writableRoot.readOnlySubpaths.forEach((excluded, excludedIndex) => {
      const excludedParam = `${rootParam}_EXCLUDED_${excludedIndex}`;
      const logical = normalizeSystemAliases(excluded);
      const resolved = canonicalOrUndefined(logical);
      const paths: [string, string][] = [[excludedParam, logical]];
      if (resolved && resolved !== logical) paths.push([`${excludedParam}_RESOLVED`, resolved]);
      for (const [param, path] of paths) {
        params.push([param, path]);
        // `subpath` alone leaves a gap for first-time creation of the protected directory itself.
        requireParts.push(`(require-not (literal (param "${param}")))`, `(require-not (subpath (param "${param}")))`);
      }
    });
    for (const name of PROTECTED_METADATA_PATH_NAMES) {
      requireParts.push(`(require-not (regex #"${protectedMetadataNameRegex(root, name).replaceAll('"', '\\"')}"))`);
    }
    components.push(`(require-all ${requireParts.join(' ')} )`);
  });
  if (!components.length) return { policy: '', params: [] };
  return { policy: [`(allow file-write*\n${components.join(' ')}\n)`, ...rootAnchorDenies].join('\n'), params };
}

function compareByComponents(left: string, right: string): number {
  const a = left.split('/').filter(Boolean), b = right.split('/').filter(Boolean);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Arguments for `/usr/bin/sandbox-exec` that run `command` under the policy. */
export function createSeatbeltCommandArgs(command: readonly string[], policy: SandboxPolicy, cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const writableRoots = policy.mode === 'workspace-write' ? workspaceWriteRoots(policy, cwd, env) : [];

  // Protect ancestors of read-only paths so renaming a writable directory cannot move descendants past their carveouts.
  const protectedAncestors = new Set<string>();
  for (const { root: logicalRoot, readOnlySubpaths } of writableRoots) {
    const root = normalizePathForSandbox(logicalRoot);
    for (const path of readOnlySubpaths) {
      const logical = normalizeSystemAliases(path);
      const resolved = canonicalOrUndefined(logical);
      for (const protectedPath of resolved && resolved !== logical ? [logical, resolved] : [logical]) {
        for (const ancestor of ancestors(protectedPath)) {
          if (!pathStartsWith(ancestor, root)) break;
          protectedAncestors.add(ancestor);
        }
      }
    }
  }
  const protectedAncestorParams = [...protectedAncestors].sort(compareByComponents)
    .map((path, index): [string, string] => [`PROTECTED_ANCESTOR_${index}`, path]);

  const write = buildWritePolicy(writableRoots);
  const networkPolicy = policy.networkAccess
    ? `(allow network-outbound)\n(allow network-inbound)\n${MACOS_SEATBELT_NETWORK_POLICY}${MACOS_SEATBELT_TLS_TRUST_POLICY}`
    : '';
  const sections = [
    MACOS_SEATBELT_BASE_POLICY,
    '; allow read-only file operations\n(allow file-read*)',
    write.policy,
    networkPolicy,
    MACOS_SEATBELT_PREFERENCES_POLICY,
    '(deny mach-lookup (xpc-service-name-prefix ""))',
    '',
    // Keep these last so no broader allowance can reopen the unlink used by rename.
    ...protectedAncestorParams.map(([key]) => `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "${key}"))))`),
    // These fcntls mutate files through read-only descriptors. F_MAKECOMPRESSED = 80, F_TRANSFEREXTENTS = 110.
    '(deny system-fcntl (fcntl-command 80 110))',
  ];
  const definitions = [...write.params, ...protectedAncestorParams].map(([key, value]) => `-D${key}=${value}`);
  return ['-p', sections.join('\n'), ...definitions, '--', ...command];
}
