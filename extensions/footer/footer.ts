import { isAbsolute, relative, sep } from 'node:path';
import type { Usage } from '@earendil-works/pi-ai';
import type { ContextUsage, ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { terminalLabel } from '../terminal-text.ts';
import { pullRequestLabel, type PullRequests } from './pull-request.ts';

export const STATUS_KEY = 'auto-permissions-status';
const tokens = (n: number) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k`
  : n < 1000000 ? `${Math.round(n / 1000)}k` : `${(n / 1000000).toFixed(1)}M`;

export function rightAligned(left: string, right: string, width: number): string {
  width = Math.max(0, Math.floor(width));
  let rightWidth = visibleWidth(right), rhs = right;
  if (width <= 0 || rightWidth > width) { rhs = truncateToWidth(right, width, ''); rightWidth = visibleWidth(rhs); }
  const room = Math.max(0, width - rightWidth - 2);
  let leftWidth = visibleWidth(left), lhs = left;
  if (room <= 0 || leftWidth > room) { lhs = truncateToWidth(left, room, room >= 3 ? '...' : ''); leftWidth = visibleWidth(lhs); }
  return lhs + ' '.repeat(Math.max(0, width - leftWidth - rightWidth)) + rhs;
}

export function permissionFooter(
  context: () => ExtensionContext,
  theme: Theme,
  data: ReadonlyFooterDataProvider,
  requestRender: () => void,
  pullRequests?: PullRequests,
) {
  const unsubscribe = data.onBranchChange(requestRender);
  let disposed = false;
  let cacheKey: string | undefined;
  let cacheLines: string[] = [];
  let memo: { sm: ExtensionContext['sessionManager']; id: string; leaf: string | null; count: number; model: ExtensionContext['model'];
    totals: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost', number>;
    cacheHit: number | undefined; usage: ContextUsage | undefined } | undefined;
  // Usage totals and context usage scan the whole session, but the footer renders every frame. Like
  // Pi's footer, reuse them until the session, leaf, entry count or model changes: entries are
  // append-only and every append moves the leaf. Pi also keys on a virtual model's routed model,
  // which extensions cannot see. It follows the latest response, so only a model catalog refresh
  // between responses can leave its context window stale, until the next entry or leaf move.
  const sessionStats = (ctx: ExtensionContext) => {
    const sm = ctx.sessionManager, id = sm.getSessionId(), leaf = sm.getLeafId(), model = ctx.model;
    // ReadonlySessionManager omits getEntryCount, but Pi hands extensions its SessionManager.
    const count = (sm as { getEntryCount?(): number }).getEntryCount?.() ?? sm.getEntries().length;
    if (memo?.sm === sm && memo.id === id && memo.leaf === leaf && memo.count === count && memo.model === model) return memo;
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let cacheHit: number | undefined;
    const add = (usage: Usage) => {
      totals.input += usage.input; totals.output += usage.output;
      totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
      totals.cost += usage.cost.total;
    };
    for (const entry of sm.getEntries()) {
      if (entry.type === 'usage') add(entry.usage);
      else if (entry.type === 'message' && entry.message.role === 'assistant') {
        const usage = entry.message.usage;
        add(usage);
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        cacheHit = prompt ? usage.cacheRead / prompt * 100 : undefined;
      } else if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.usage) add(entry.message.usage);
      else if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) add(entry.usage);
    }
    return memo = { sm, id, leaf, count, model, totals, cacheHit, usage: ctx.getContextUsage() };
  };
  const home = process.env.HOME || process.env.USERPROFILE;
  let rawCwd: string | undefined, homeCwd = '';
  return {
    invalidate() { cacheKey = undefined; memo = undefined; },
    dispose() { if (!disposed) { disposed = true; unsubscribe(); pullRequests?.dispose(); } },
    render(width: number): string[] {
      const ctx = context();
      const raw = ctx.sessionManager.getCwd();
      if (raw !== rawCwd) {
        let cwd = raw;
        if (home) {
          const rel = relative(home, cwd);
          if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) cwd = rel ? `~${sep}${rel}` : '~';
        }
        rawCwd = raw; homeCwd = cwd;
      }
      const cwd = homeCwd;
      const branch = data.getGitBranch(), name = ctx.sessionManager.getSessionName();
      const base = terminalLabel(`${cwd}${branch ? ` (${branch})` : ''}`), tail = name ? ` • ${terminalLabel(name)}` : '';
      const pr = pullRequests?.get(raw, branch), label = pr && pullRequestLabel(pr);
      const statuses = data.getExtensionStatuses();
      const auto = terminalLabel(statuses.get(STATUS_KEY) ?? 'Auto: unavailable');
      const { totals, cacheHit, usage } = sessionStats(ctx);
      const stats: string[] = [];
      for (const [key, prefix] of [['input', '↑'], ['output', '↓'], ['cacheRead', 'R'], ['cacheWrite', 'W']] as const) {
        if (totals[key]) stats.push(`${prefix}${tokens(totals[key])}`);
      }
      if ((totals.cacheRead || totals.cacheWrite) && cacheHit !== undefined) stats.push(`CH${cacheHit.toFixed(1)}%`);
      const subscription = ctx.model && (ctx.model.provider === 'kimi-coding'
        || (ctx.modelRegistry.isUsingOAuth(ctx.model)
          && ctx.modelRegistry.getProvider(ctx.model.provider)?.auth.oauth?.isSubscription === true));
      if (totals.cost || subscription) stats.push(`$${totals.cost.toFixed(3)}${subscription ? ' (sub)' : ''}`);
      const percent = usage?.percent;
      const contextLabel = `${percent == null ? '?' : percent.toFixed(1) + '%'}/${tokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)}`;
      stats.push(theme.fg(percent != null && percent > 90 ? 'error' : percent != null && percent > 70 ? 'warning' : 'dim', contextLabel));
      let model = terminalLabel(ctx.model?.id ?? 'no-model');
      if (ctx.model?.reasoning) model += ` • ${ctx.thinkingLevel ?? 'off'}`;
      if (ctx.model && data.getAvailableProviderCount() > 1) model = `(${terminalLabel(ctx.model.provider)}) ${model}`;
      const pathRow = theme.fg('dim', base) + (label ? ` ${theme.fg('warning', label)}` : '') + theme.fg('dim', tail), autoRow = theme.fg('dim', auto);
      const statsRow = theme.fg('dim', stats.join(' ')), modelRow = theme.fg('dim', model);
      const other = [...statuses].filter(([key]) => key !== STATUS_KEY).sort(([a], [b]) => a.localeCompare(b));
      const others = other.length ? other.map(([, text]) => terminalLabel(text)).join(' ') : undefined;
      const key = `${width}.${pathRow.length}.${autoRow.length}.${statsRow.length}`
        + `.${modelRow.length}.${others?.length ?? -1}|`
        + pathRow + autoRow + statsRow + modelRow + (others ?? '');
      if (key === cacheKey) return cacheLines;
      let pathLine = rightAligned(pathRow, autoRow, width);
      if (label) {
        const wholeLabel = `${base} ${stripTerminalSequences(label)}`, shown = stripTerminalSequences(pathLine);
        const labelCut = !shown.startsWith(wholeLabel) || ![undefined, ' '].includes(shown[wholeLabel.length]);
        if (labelCut) pathLine = rightAligned(theme.fg('dim', base + tail), autoRow, width);
      }
      const lines = [pathLine, rightAligned(statsRow, modelRow, width)];
      if (others !== undefined) lines.push(truncateToWidth(others, Math.max(0, width), ''));
      cacheKey = key; cacheLines = lines;
      return lines;
    },
  };
}
