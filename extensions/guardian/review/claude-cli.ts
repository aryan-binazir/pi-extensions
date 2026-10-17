// Claude reviews through Claude Code's print mode (`claude -p`), isolated from your Claude customizations
// (`--safe-mode`) and limited to read-only file tools. The verdict is parsed with Codex's assessment parser.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { parseGuardianAssessment } from './assessment.ts';
import { isTransientProviderError, type ReviewOutcome } from './outcome.ts';
import { runBounded } from './process.ts';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ClaudeCliReview {
  command?: string;
  systemPrompt: string;
  userContent: string[];
  cwd: string;
  model: string;
  reasoning: ThinkingLevel;
  /** Epoch milliseconds shared by every attempt of one review. */
  deadline: number;
  signal?: AbortSignal;
}

/** Claude Code has no `minimal` effort; it maps to `low`. */
const effort = (reasoning: ThinkingLevel) => reasoning === 'minimal' ? 'low' : reasoning;

export function claudeCliArgs(review: Pick<ClaudeCliReview, 'systemPrompt' | 'model' | 'reasoning' | 'cwd'>): string[] {
  return [
    // `--restricted` drops the command-running tools and ignores user, project and local settings, and
    // `--setting-sources ''` leaves none of them. Without both, a `.claude/settings.json` the agent wrote
    // in its workspace could make the reviewer run a helper command on the host.
    '-p', '--safe-mode', '--restricted', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
    '--add-dir', review.cwd, '--model', review.model, '--effort', effort(review.reasoning), '--system-prompt', review.systemPrompt,
    '--tools', ...READ_ONLY_TOOLS, '--allowedTools', ...READ_ONLY_TOOLS, '--permission-mode', 'dontAsk',
    '--output-format', 'json',
  ];
}

export async function runClaudeCliReview(review: ClaudeCliReview): Promise<ReviewOutcome> {
  const stdin = review.userContent.map(part => part.endsWith('\n') ? part : `${part}\n\n`).join('');
  // Run outside the reviewed workspace: Claude discovers CLAUDE.md, settings and hooks from its own cwd.
  const neutralCwd = mkdtempSync(join(tmpdir(), 'guardian-review-'));
  try {
    return await claudeReview(review, stdin, neutralCwd);
  } finally {
    rmSync(neutralCwd, { recursive: true, force: true });
  }
}

async function claudeReview(review: ClaudeCliReview, stdin: string, neutralCwd: string): Promise<ReviewOutcome> {
  const run = await runBounded(review.command ?? 'claude', claudeCliArgs(review), {
    cwd: neutralCwd, stdin, timeoutMs: review.deadline - Date.now(), maxBytes: MAX_OUTPUT_BYTES, ...(review.signal ? { signal: review.signal } : {}),
  });
  if (run.aborted) return { type: 'error', error: { type: 'cancelled' } };
  if (run.timedOut) return { type: 'error', error: { type: 'timeout' } };
  if (run.spawnError) return { type: 'error', error: { type: 'session', message: `claude -p could not start: ${run.spawnError}`, transient: false } };
  let result: { is_error?: boolean; result?: unknown; api_error_status?: number | null } | undefined;
  try { result = JSON.parse(run.stdout); } catch { result = undefined; }
  if (run.exitCode !== 0 || !result || result.is_error) {
    const status = result?.api_error_status ? String(result.api_error_status) : `exit ${run.exitCode}`;
    const detail = (typeof result?.result === 'string' && result.result) || run.stderr.trim() || run.stdout.trim() || 'no output';
    const message = `claude -p failed (${status}): ${detail.slice(0, 500)}`;
    return { type: 'error', error: { type: 'session', message, transient: isTransientProviderError(message) || /overload/i.test(detail) } };
  }
  const text = typeof result.result === 'string' ? result.result : '';
  if (!text.trim()) return { type: 'error', error: { type: 'session', message: 'guardian review completed without an assessment payload', transient: false } };
  try {
    return { type: 'completed', assessment: parseGuardianAssessment(text) };
  } catch (error) {
    return { type: 'error', error: { type: 'parse', message: (error as Error).message } };
  }
}
