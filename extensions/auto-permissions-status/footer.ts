import { isAbsolute, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const STATUS_KEY = 'auto-permissions-status';
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const tokens = (n: number) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k`
  : n < 1000000 ? `${Math.round(n / 1000)}k` : `${(n / 1000000).toFixed(1)}M`;

/** Give the right-hand status priority; truncate the path, never wrap a row. */
export function rightAligned(left: string, right: string, width: number): string {
  width = Math.max(0, Math.floor(width));
  const rhs = truncateToWidth(right, width, '');
  const room = Math.max(0, width - visibleWidth(rhs) - 2);
  const lhs = truncateToWidth(left, room, room >= 3 ? '...' : '');
  return lhs + ' '.repeat(Math.max(0, width - visibleWidth(lhs) - visibleWidth(rhs))) + rhs;
}

/** Uses public extension context only; does not fabricate an AgentSession or
 * reach into Pi's private footer internals. Other extensions keep their status row. */
export function permissionFooter(
  context: () => ExtensionContext,
  theme: Theme,
  data: ReadonlyFooterDataProvider,
  requestRender: () => void,
) {
  const unsubscribe = data.onBranchChange(requestRender);
  let disposed = false;
  return {
    invalidate() {},
    dispose() { if (!disposed) { disposed = true; unsubscribe(); } },
    render(width: number): string[] {
      const ctx = context();
      let cwd = ctx.sessionManager.getCwd();
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        const rel = relative(home, cwd);
        if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) cwd = rel ? `~${sep}${rel}` : '~';
      }
      const branch = data.getGitBranch(), name = ctx.sessionManager.getSessionName();
      const path = clean(`${cwd}${branch ? ` (${branch})` : ''}${name ? ` • ${name}` : ''}`);
      const statuses = data.getExtensionStatuses();
      const auto = clean(statuses.get(STATUS_KEY) ?? 'Auto: unavailable');
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      let cacheHit: number | undefined;
      const add = (usage: Usage) => {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) totals[key] += usage[key];
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
      const lines = [
        rightAligned(theme.fg('dim', path), theme.fg('dim', auto), width),
        rightAligned(theme.fg('dim', stats.join(' ')), theme.fg('dim', model), width),
      ];
      const other = [...statuses].filter(([key]) => key !== STATUS_KEY).sort(([a], [b]) => a.localeCompare(b));
      if (other.length) lines.push(truncateToWidth(other.map(([, text]) => clean(text)).join(' '), Math.max(0, width), ''));
      return lines;
    },
  };
}
