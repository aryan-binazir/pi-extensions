import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export interface Checkout { path: string; branch: string; primary: boolean }
interface Options { home?: string; herdr?: boolean }
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
  private async herdrState(): Promise<unknown | undefined> {
    if (!(this.options.herdr ?? process.env.HERDR_ENV === '1')) return;
    try { return JSON.parse(await this.run('herdr', ['worktree', 'list', '--cwd', this.cwd])); }
    catch (error) {
      const failure = error as { code?: string | number; stderr?: string };
      if (failure.code === 'ENOENT') return;
      try { if (JSON.parse(failure.stderr ?? '{}')?.error?.code === 'server_not_running') return; } catch { /* Unknown failure must not trigger a fallback mutation. */ }
      throw error;
    }
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
      if (herdr !== undefined) await this.run('herdr', ['worktree', 'open', '--cwd', this.cwd, '--path', reused.path, '--no-focus']);
      return reused;
    }
    const path = join(this.options.home ?? homedir(), 'repos', '.worktrees', basename(existing[0].path), leaf);
    await mkdir(resolve(path, '..'), { recursive: true });
    if (herdr !== undefined) {
      await this.run('herdr', ['worktree', 'create', '--cwd', this.cwd, '--branch', branch, '--base', options.base ?? 'main', '--path', path, '--no-focus']);
    } else {
      let branchExists = false;
      try { await this.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); branchExists = true; } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
      await this.run('git', branchExists ? ['worktree', 'add', '--', path, branch] : ['worktree', 'add', '-b', branch, '--', path, options.base ?? 'main']);
    }
    const created = await this.list();
    const canonical = await realpath(path);
    const checkout = created.find(item => item.branch === branch && resolve(item.path) === canonical);
    if (!checkout) throw new Error('Worktree command did not create the requested checkout');
    return checkout;
  }
  async remove(path: string, options: { force?: boolean; confirm: (message: string) => Promise<boolean> }): Promise<{ removed: boolean; reason?: string }> {
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
  async cleanup(options: { force?: boolean; confirm: (message: string) => Promise<boolean> }): Promise<Array<{ path: string; removed: boolean; reason?: string }>> {
    const results = [];
    for (const checkout of await this.list()) {
      if (checkout.primary || !checkout.branch) continue;
      if (within(await realpath(checkout.path), await realpath(this.cwd))) { results.push({ path: checkout.path, removed: false, reason: 'original session directory' }); continue; }
      let merged: boolean;
      try {
        const prs = JSON.parse(await this.run('gh', ['pr', 'list', '--head', checkout.branch, '--state', 'all', '--json', 'state,headRefOid,mergedAt', '--limit', '100'])) as Array<{ state: string; headRefOid: string; mergedAt: string | null }>;
        const head = await this.run('git', ['-C', checkout.path, 'rev-parse', 'HEAD']);
        merged = prs.some(pr => pr.state === 'MERGED' && pr.mergedAt && pr.headRefOid === head);
      } catch { results.push({ path: checkout.path, removed: false, reason: 'PR merge status unavailable' }); continue; }
      if (!merged) { results.push({ path: checkout.path, removed: false, reason: 'no merged PR at checkout HEAD' }); continue; }
      results.push({ path: checkout.path, ...await this.remove(checkout.path, options) });
    }
    return results;
  }
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && suffix !== '..' && !isAbsolute(suffix));
}
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
