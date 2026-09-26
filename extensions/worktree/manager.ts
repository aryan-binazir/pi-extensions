import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export interface Checkout { path: string; branch: string; primary: boolean }
interface Options { home?: string; herdr?: boolean }
interface Removal { removed: boolean; reason?: string }
interface CheckoutRemoval extends Removal { path: string }
export class Worktrees {
  constructor(readonly cwd: string, private readonly options: Options = {}) {}
  private async run(command: string, args: string[]) {
    const { stdout } = await execute(command, args, { cwd: this.cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }
  async list(): Promise<Checkout[]> {
    const output = await this.run('git', ['worktree', 'list', '--porcelain', '-z']);
    return output.split('\0\0').filter(Boolean).map((record, index) => {
      const fields = record.split('\0');
      return { path: fields.find(line => line.startsWith('worktree '))!.slice(9), branch: fields.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? '', primary: index === 0 };
    });
  }
  /** Confirm that a listed path still leads to its registered Git checkout. */
  async matches(checkout: Checkout): Promise<boolean> {
    try {
      if (!(await stat(checkout.path)).isDirectory()) return false;
      const path = await realpath(checkout.path);
      const root = await realpath(await this.run('git', ['-C', checkout.path, 'rev-parse', '--show-toplevel']));
      if (root !== path) return false;
      const common = await realpath(await this.run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const checkoutCommon = await realpath(await this.run('git', ['-C', checkout.path, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (checkoutCommon !== common) return false;
      if (await this.run('git', ['-C', checkout.path, 'rev-parse', '--abbrev-ref', 'HEAD']) !== (checkout.branch || 'HEAD')) return false;
      const gitdir = await realpath(await this.run('git', ['-C', checkout.path, 'rev-parse', '--absolute-git-dir']));
      if (checkout.primary) return gitdir === common && await realpath(join(checkout.path, '.git')) === common;
      if (dirname(gitdir) !== join(common, 'worktrees')) return false;
      return resolve(gitdir, (await readFile(join(gitdir, 'gitdir'), 'utf8')).trim()) === resolve(checkout.path, '.git');
    } catch { return false; }
  }
  /** `undefined` means Herdr is not in play; any other value is the parsed `herdr worktree list` payload. */
  private async herdrState(): Promise<unknown> {
    if (!(this.options.herdr ?? process.env.HERDR_ENV === '1')) return;
    try { return JSON.parse(await this.run('herdr', ['worktree', 'list', '--cwd', this.cwd])); }
    catch (error) {
      const failure = error as { code?: string | number; stderr?: string };
      if (failure.code === 'ENOENT') return;
      try { if (JSON.parse(failure.stderr ?? '{}')?.error?.code === 'server_not_running') return; } catch { /* Unknown failure must not trigger a fallback mutation. */ }
      throw error;
    }
  }
  private async defaultBase(): Promise<string> {
    try { return await this.run('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']); } catch { /* Local-only repositories may have no remote default. */ }
    for (const branch of ['main', 'master']) {
      try { await this.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return branch; } catch { continue; }
    }
    throw new Error('Cannot determine the default branch; specify --base <ref>');
  }
  async open(name: string, options: { branch?: string; base?: string } = {}): Promise<Checkout> {
    const branch = options.branch ?? (name.includes('/') ? name : `amb/${name}`);
    const leaf = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf) || leaf === '.' || leaf === '..') throw new Error('Worktree name must be a single safe directory name');
    await this.run('git', ['check-ref-format', '--branch', branch]);
    const existing = await this.list();
    const herdr = await this.herdrState();
    const reused = existing.find(item => item.branch === branch);
    if (reused) {
      if (!await this.matches(reused)) throw new Error(`Worktree directory is unavailable or no longer matches its Git checkout: ${reused.path}. Restore it or remove its stale Git worktree entry before retrying.`);
      if (herdr !== undefined) await this.run('herdr', ['worktree', 'open', '--cwd', this.cwd, '--path', reused.path, '--no-focus']);
      return reused;
    }
    const path = join(this.options.home ?? homedir(), 'repos', '.worktrees', basename(existing[0].path), leaf);
    await mkdir(resolve(path, '..'), { recursive: true });
    if (herdr !== undefined) {
      await this.run('herdr', ['worktree', 'create', '--cwd', this.cwd, '--branch', branch, '--base', options.base ?? await this.defaultBase(), '--path', path, '--no-focus']);
    } else {
      let branchExists = false;
      try { await this.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); branchExists = true; } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
      await this.run('git', branchExists ? ['worktree', 'add', '--', path, branch] : ['worktree', 'add', '-b', branch, '--', path, options.base ?? await this.defaultBase()]);
    }
    const created = await this.list();
    const canonical = await realpath(path);
    const checkout = created.find(item => item.branch === branch && resolve(item.path) === canonical);
    if (!checkout) throw new Error('Worktree command did not create the requested checkout');
    return checkout;
  }
  async remove(path: string, options: { force?: boolean; confirm: (message: string) => Promise<boolean> }): Promise<Removal> {
    const canonical = await realpath(path);
    const checkout = (await this.list()).find(item => resolve(item.path) === canonical);
    if (!checkout || checkout.primary) throw new Error('Refusing to remove an unknown or primary checkout');
    const original = await realpath(this.cwd);
    if (within(canonical, original)) throw new Error('Refusing to remove the original session directory');
    const layout = await realpath(join(this.options.home ?? homedir(), 'repos', '.worktrees'));
    if (!within(layout, canonical)) throw new Error('Refusing to remove a checkout outside the managed worktree directory');
    const herdr = await this.herdrState();
    const workspace = herdr === undefined ? undefined : await findWorkspace(herdr, canonical);
    if (herdr !== undefined && workspace === undefined) throw new Error('Cannot identify the Herdr worktree; removal blocked');
    if (workspace && workspace === process.env.HERDR_WORKSPACE_ID) throw new Error('Refusing to close the active Herdr workspace');
    const dirty = await this.run('git', ['-C', checkout.path, 'status', '--porcelain']);
    if (dirty && !options.force) return { removed: false, reason: 'dirty' };
    if (!await options.confirm(`Remove ${checkout.path}${dirty ? ' including uncommitted files (--force)' : ''}?`)) return { removed: false, reason: 'not confirmed' };
    // Recheck after the dialog: another process may have edited the checkout.
    if (!options.force && await this.run('git', ['-C', checkout.path, 'status', '--porcelain'])) return { removed: false, reason: 'dirty' };
    if (workspace) {
      await this.run('herdr', ['worktree', 'remove', '--workspace', workspace, ...(options.force ? ['--force'] : [])]);
    } else await this.run('git', ['worktree', 'remove', ...(options.force ? ['--force'] : []), '--', checkout.path]);
    return { removed: true };
  }
  async cleanup(options: { force?: boolean; confirm: (message: string) => Promise<boolean> }): Promise<CheckoutRemoval[]> {
    const results: CheckoutRemoval[] = [];
    for (const checkout of await this.list()) {
      if (checkout.primary || !checkout.branch) continue;
      try {
        if (within(await realpath(checkout.path), await realpath(this.cwd))) { results.push({ path: checkout.path, removed: false, reason: 'original session directory' }); continue; }
        let merged: boolean;
        try {
          const prs = JSON.parse(await this.run('gh', ['pr', 'list', '--head', checkout.branch, '--state', 'all', '--json', 'state,headRefOid,mergedAt', '--limit', '100'])) as Array<{ state: string; headRefOid: string; mergedAt: string | null }>;
          const head = await this.run('git', ['-C', checkout.path, 'rev-parse', 'HEAD']);
          merged = prs.some(pr => pr.state === 'MERGED' && pr.mergedAt && pr.headRefOid === head);
        } catch { results.push({ path: checkout.path, removed: false, reason: 'PR merge status unavailable' }); continue; }
        if (!merged) { results.push({ path: checkout.path, removed: false, reason: 'no merged PR at checkout HEAD' }); continue; }
        results.push({ path: checkout.path, ...await this.remove(checkout.path, options) });
      } catch (error) {
        results.push({ path: checkout.path, removed: false, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}
/** Tri-state: a workspace id, `null` for a known-but-unopened worktree, `undefined` when this path is not in the payload at all. */
async function findWorkspace(value: unknown, path: string): Promise<string | null | undefined> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) { const found = await findWorkspace(item, path); if (found !== undefined) return found; }
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && Object.hasOwn(record, 'open_workspace_id')) {
    try {
      if (await realpath(record.path) === path) {
        if (record.open_workspace_id === null || typeof record.open_workspace_id === 'string') return record.open_workspace_id;
        throw new Error('Invalid Herdr workspace identifier');
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const item of Object.values(record)) { const found = await findWorkspace(item, path); if (found !== undefined) return found; }
}
