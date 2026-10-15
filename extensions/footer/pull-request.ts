import { basename } from 'node:path';
import { invocations } from '../hooks/shell.ts';
import type { ExecResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui';
import { terminalLabel } from '../terminal-text.ts';

export interface PullRequest { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean }
export interface PullRequests {
  /** Reads cached state and schedules discovery for an unseen cwd and branch. */
  get(cwd: string, branch: string | null): PullRequest | undefined;
  /** Coalesces changes; a non-forced refresh requires an answer at least a minute old. */
  refresh(changed?: boolean): void;
  dispose(): void;
}

const stateWords = { MERGED: ' merged', CLOSED: ' closed', OPEN: '' };
export const pullRequestLabel = (pr: PullRequest) => (getCapabilities().hyperlinks ? hyperlink(`#${pr.number}`, pr.url) : `#${pr.number}`)
  + (pr.state === 'OPEN' && pr.isDraft ? ' draft' : stateWords[pr.state]);

const states = new Set(['OPEN', 'CLOSED', 'MERGED']);
const same = (a: PullRequest | undefined, b: PullRequest | undefined) => a === b
  || (!!a && !!b && a.number === b.number && a.url === b.url && a.state === b.state && a.isDraft === b.isDraft);
const webUrl = (url: unknown) => {
  if (typeof url !== 'string' || terminalLabel(url) !== url || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
};
// Pi reports a signal-terminated process as exit code 0, so `killed` must be checked too.
// gh reads a numeric or #N selector as a PR number even after `--`, so the PR must be this branch's.
const parse = (result: ExecResult, branch: string): PullRequest | undefined => {
  if (result.killed || result.code !== 0) return undefined;
  const pr = JSON.parse(result.stdout) as Partial<Record<keyof PullRequest | 'headRefName', unknown>> | null;
  const url = webUrl(pr?.url);
  if (!pr || !url || pr.headRefName !== branch || !Number.isSafeInteger(pr.number) || (pr.number as number) <= 0
    || typeof pr.state !== 'string' || !states.has(pr.state) || typeof pr.isDraft !== 'boolean') return undefined;
  return { number: pr.number as number, url, state: pr.state as PullRequest['state'], isDraft: pr.isDraft };
};

export function changesPullRequest(command: string): boolean {
  return invocations(command).some(invocation => {
    let name = basename(invocation.name), args = invocation.args;
    if (name === 'command' || name === 'env') {
      let i = 0;
      while (args[i] === '--' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i] ?? '')) i++;
      name = basename(args[i] ?? ''); args = args.slice(i + 1);
    }
    if (name !== 'git' && name !== 'gh') return false;
    let i = 0;
    while (args[i]?.startsWith('-')) {
      const flag = args[i++];
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '-R', '--repo', '--hostname'].includes(flag)) i++;
      if (flag === '--') break;
    }
    return name === 'gh' ? args[i] === 'pr' : ['push', 'pull', 'switch', 'checkout', 'merge', 'rebase', 'reset', 'branch'].includes(args[i]);
  });
}

interface CachedRequest {
  pr?: PullRequest;
  completed?: number;
  unavailable?: boolean;
  pending?: Promise<void>;
  listeners: Set<() => void>;
}
interface RequestCache { entries: Map<string, CachedRequest>; lastKey?: string }
const cacheKey = Symbol.for('pi-interactive:footer.pull-requests.v1');
const unavailable = (message: string) => /ENOENT|command not found|not found in PATH|none of the git remotes|known GitHub host|not a git repository|not a GitHub (?:host|repository)/i.test(message);
const offline = () => /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '');

export function pullRequests(exec: ExtensionAPI['exec'], onChange: () => void): PullRequests {
  const registry = globalThis as unknown as Record<symbol, RequestCache | undefined>;
  const cache: RequestCache = registry[cacheKey] ??= { entries: new Map() };
  let key: string | undefined, target: { cwd: string; branch: string; entry: CachedRequest } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, waiting = false;
  const updated = () => { if (!disposed) onChange(); };
  const schedule = () => {
    if (disposed || !target || offline()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(lookup, 1500);
    timer.unref();
  };
  const lookup = () => {
    timer = undefined;
    if (disposed || !target || offline()) return;
    const { cwd, branch, entry } = target;
    if (entry.pending) {
      if (!waiting) {
        waiting = true;
        void entry.pending.then(() => { waiting = false; if (target?.entry === entry) schedule(); });
      }
      return;
    }
    const previous = entry.pr;
    const args = ['pr', 'view', '--json', 'number,url,state,isDraft,headRefName', '--', branch];
    entry.pending = Promise.resolve().then(() => exec('gh', args, { cwd, timeout: 10000 }))
      .then(result => { entry.unavailable = !result.killed && ((result.code !== 0 && !result.stderr.trim()) || unavailable(result.stderr)); entry.pr = parse(result, branch); })
      .catch(error => { entry.unavailable = unavailable(String(error)); entry.pr = undefined; })
      .then(() => {
        entry.completed = Date.now(); entry.pending = undefined;
        if (!same(previous, entry.pr)) for (const listener of entry.listeners) listener();
      });
  };
  return {
    get(cwd, branch) {
      if (disposed) return undefined;
      // Pi reports a detached HEAD as "detached" and a non-repository as null.
      const next = branch && branch !== 'detached' ? `${cwd}\0${branch}` : undefined;
      if (next !== key) {
        if (timer) clearTimeout(timer);
        timer = undefined; waiting = false;
        target?.entry.listeners.delete(updated);
        key = next; target = undefined;
        if (next) {
          const entry = cache.entries.get(next) ?? { listeners: new Set<() => void>() };
          cache.entries.set(next, entry);
          if (cache.lastKey !== next && entry.unavailable) { entry.unavailable = false; entry.completed = undefined; }
          entry.listeners.add(updated);
          target = { cwd, branch: branch!, entry };
          if (!entry.pending && !entry.unavailable && (entry.completed === undefined || Date.now() - entry.completed >= 60000)) schedule();
        }
        cache.lastKey = next;
      }
      return target?.entry.pr;
    },
    refresh(changed = true) {
      if (disposed || !target || offline()) return;
      const entry = target.entry;
      if (changed) { entry.unavailable = false; schedule(); }
      else if (!entry.unavailable && !entry.pending && !timer && (entry.completed === undefined || Date.now() - entry.completed >= 60000)) schedule();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      target?.entry.listeners.delete(updated);
    },
  };
}
