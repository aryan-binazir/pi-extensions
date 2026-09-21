import { isAbsolute, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const STATUS_KEY = 'auto-permissions-status';
// Every escape sequence stripVTControlCharacters removes starts with a Cc code
// point, so one early-exiting scan proves both passes are no-ops for plain text.
const suspect = /[\p{Cc}\p{Cf}]/u;
const clean = (text: string) => suspect.test(text)
  ? stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ') : text;
const tokens = (n: number) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k`
  : n < 1000000 ? `${Math.round(n / 1000)}k` : `${(n / 1000000).toFixed(1)}M`;

/** Give the right-hand status priority; truncate the path, never wrap a row. */
export function rightAligned(left: string, right: string, width: number): string {
  width = Math.max(0, Math.floor(width));
  // truncateToWidth returns its input unchanged once it fits, and it walks
  // grapheme clusters to find that out. visibleWidth memoises per string, and
  // both sides need their width anyway, so measure first and only cut on overflow.
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
) {
  const unsubscribe = data.onBranchChange(requestRender);
  let disposed = false;
  // The TUI re-renders every child on each keystroke and streamed chunk, but the
  // footer's inputs only move on session events. Key the finished rows on the
  // themed strings that produce them and skip the width maths when nothing moved.
  let cacheKey: string | undefined;
  let cacheLines: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  let rawCwd: string | undefined, homeCwd = '';
  return {
    invalidate() { cacheKey = undefined; },
    dispose() { if (!disposed) { disposed = true; unsubscribe(); } },
    render(width: number): string[] {
      const ctx = context();
      const raw = ctx.sessionManager.getCwd();
      if (raw !== rawCwd) {
        // The cwd moves at most once a session; the path maths need not repeat.
        let cwd = raw;
        if (home) {
          const rel = relative(home, cwd);
          if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) cwd = rel ? `~${sep}${rel}` : '~';
        }
        rawCwd = raw; homeCwd = cwd;
      }
      const cwd = homeCwd;
      const branch = data.getGitBranch(), name = ctx.sessionManager.getSessionName();
      const path = clean(`${cwd}${branch ? ` (${branch})` : ''}${name ? ` • ${name}` : ''}`);
      const statuses = data.getExtensionStatuses();
      const auto = clean(statuses.get(STATUS_KEY) ?? 'Auto: unavailable');
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      let cacheHit: number | undefined;
      const add = (usage: Usage) => {
        totals.input += usage.input; totals.output += usage.output;
        totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
        totals.cost += usage.cost.total;
      };
      // Match Pi's accounting scope: all entries, including tool and summary usage.
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const usage = entry.message.usage;
          add(usage);
          const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
          cacheHit = prompt ? usage.cacheRead / prompt * 100 : undefined;
        } else if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.usage) add(entry.message.usage);
        else if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) add(entry.usage);
      }
      const stats: string[] = [];
      for (const [key, prefix] of [['input', '↑'], ['output', '↓'], ['cacheRead', 'R'], ['cacheWrite', 'W']] as const) {
        if (totals[key]) stats.push(`${prefix}${tokens(totals[key])}`);
      }
      if ((totals.cacheRead || totals.cacheWrite) && cacheHit !== undefined) stats.push(`CH${cacheHit.toFixed(1)}%`);
      const subscription = ctx.model && (ctx.model.provider === 'kimi-coding' || ctx.modelRegistry.isUsingOAuth(ctx.model));
      if (totals.cost || subscription) stats.push(`$${totals.cost.toFixed(3)}${subscription ? ' (sub)' : ''}`);
      const usage = ctx.getContextUsage();
      const percent = usage?.percent;
      const contextLabel = `${percent == null ? '?' : percent.toFixed(1) + '%'}/${tokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)}`;
      stats.push(theme.fg(percent != null && percent > 90 ? 'error' : percent != null && percent > 70 ? 'warning' : 'dim', contextLabel));
      let model = clean(ctx.model?.id ?? 'no-model');
      if (ctx.model?.reasoning) model += ` • ${ctx.thinkingLevel ?? 'off'}`;
      if (ctx.model && data.getAvailableProviderCount() > 1) model = `(${clean(ctx.model.provider)}) ${model}`;
      const pathRow = theme.fg('dim', path), autoRow = theme.fg('dim', auto);
      const statsRow = theme.fg('dim', stats.join(' ')), modelRow = theme.fg('dim', model);
      const other = [...statuses].filter(([key]) => key !== STATUS_KEY).sort(([a], [b]) => a.localeCompare(b));
      const others = other.length ? other.map(([, text]) => clean(text)).join(' ') : undefined;
      // Length-prefixed rather than separated: no themed string can forge a
      // boundary, and a missing status row is -1, which no length can be.
      const key = `${width}.${pathRow.length}.${autoRow.length}.${statsRow.length}`
        + `.${modelRow.length}.${others?.length ?? -1}|`
        + pathRow + autoRow + statsRow + modelRow + (others ?? '');
      if (key === cacheKey) return cacheLines;
      const lines = [rightAligned(pathRow, autoRow, width), rightAligned(statsRow, modelRow, width)];
      if (others !== undefined) lines.push(truncateToWidth(others, Math.max(0, width), ''));
      cacheKey = key; cacheLines = lines;
      return lines;
    },
  };
}
