import type { ExecResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui';

export interface PullRequest { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean }
export interface PullRequests {
  /** The PR for this cwd and branch; a pair not seen last time starts a lookup and returns undefined until it answers. */
  get(cwd: string, branch: string | null): PullRequest | undefined;
  /** Asks gh again for the last pair, keeping the current answer until the new one arrives. */
  refresh(): void;
  dispose(): void;
}

const stateWords = { MERGED: ' merged', CLOSED: ' closed', OPEN: '' };
// Like Pi's own links, the number is plain text where the terminal cannot show hyperlinks.
export const pullRequestLabel = (pr: PullRequest) => (getCapabilities().hyperlinks ? hyperlink(`#${pr.number}`, pr.url) : `#${pr.number}`)
  + (pr.state === 'OPEN' && pr.isDraft ? ' draft' : stateWords[pr.state]);

const states = new Set(['OPEN', 'CLOSED', 'MERGED']);
const same = (a: PullRequest | undefined, b: PullRequest | undefined) => a === b
  || (!!a && !!b && a.number === b.number && a.url === b.url && a.state === b.state && a.isDraft === b.isDraft);
const controls = /[\p{Cc}\p{Cf}]/u;
const webUrl = (url: unknown) => {
  if (typeof url !== 'string' || controls.test(url) || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
};
// The footer prints the URL inside a terminal escape sequence, so every field is checked before it is trusted.
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

export function pullRequests(exec: ExtensionAPI['exec'], onChange: () => void): PullRequests {
  let key: string | undefined, target: { cwd: string; branch: string } | undefined;
  let current: PullRequest | undefined, controller: AbortController | undefined;
  let generation = 0, disposed = false;
  // Only the newest lookup may answer; starting one aborts the one before.
  const lookup = () => {
    controller?.abort(); controller = undefined;
    const version = ++generation;
    if (!target) return;
    const { cwd, branch } = target, signal = (controller = new AbortController()).signal;
    // gh is asked about the branch the footer shows, not whatever HEAD is by the time it runs;
    // `--` keeps an odd branch name from being read as a flag.
    // Any failure, whether no PR, no gh, signed out or offline, shows the footer without a link.
    const args = ['pr', 'view', '--json', 'number,url,state,isDraft,headRefName', '--', branch];
    void new Promise<ExecResult>(resolve => resolve(exec('gh', args, { cwd, signal, timeout: 10000 })))
      .then(result => parse(result, branch)).catch(() => undefined).then(pr => {
        if (version !== generation || same(pr, current)) return;
        current = pr;
        onChange();
      });
  };
  return {
    get(cwd, branch) {
      if (disposed) return undefined;
      // Pi reports a detached HEAD as the branch name "detached" and a non-repository as null.
      const next = branch && branch !== 'detached' ? `${cwd}\0${branch}` : undefined;
      if (next !== key) {
        key = next; current = undefined;
        target = next ? { cwd, branch: branch! } : undefined;
        lookup();
      }
      return current;
    },
    refresh() { if (!disposed && target) lookup(); },
    dispose() {
      disposed = true;
      controller?.abort(); controller = undefined;
      ++generation;
    },
  };
}
