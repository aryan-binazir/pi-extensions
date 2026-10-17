// Where Guardian's preferences live. Mirrors Codex's `$CODEX_HOME/config.toml` and `$CODEX_HOME/rules/*.rules`
// (openai/codex codex-rs/core/src/exec_policy.rs @ ce0323f, Apache-2.0), plus rules and policy shared through this repo.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { BANNED_PREFIX_SUGGESTIONS, loadExecPolicy } from './exec-policy.ts';
import { isRailwayProgram, railwayDecision, RAILWAY_EXTRA_POLICY } from './railway.ts';
import type { Policy } from './rules.ts';
import type { Shell } from './shell.ts';

const BUNDLED_DIR = fileURLToPath(new URL('../../personal-settings/guardian/', import.meta.url));
/** Rules every machine loads; their forbidden prefixes cannot be relaxed by user rules or config. */
export const BUNDLED_RULES_DIR = join(BUNDLED_DIR, 'rules');
/** Reviewer policy every machine loads ahead of the user's `extraPolicy`. */
export const BUNDLED_EXTRA_POLICY_PATH = join(BUNDLED_DIR, 'extra-policy.md');

export const guardianDir = () => join(getAgentDir(), 'guardian');
export const guardianConfigPath = () => join(guardianDir(), 'config.json');
export const userRulesDir = () => join(guardianDir(), 'rules');
/** Codex appends approved prefix rules to `rules/default.rules`. */
export const defaultRulesPath = () => join(userRulesDir(), 'default.rules');

export interface LoadedPolicies {
  /** Bundled rules plus your rules, when yours load. */
  policy: Policy;
  /** Set when your rules could not be loaded; the bundled rules still apply. */
  warning?: string;
}

export async function loadPolicies(userRulesDirs: readonly string[]): Promise<LoadedPolicies> {
  const bundled = await loadExecPolicy([BUNDLED_RULES_DIR]);
  if (!userRulesDirs.length) return { policy: bundled };
  try {
    return { policy: await loadExecPolicy([BUNDLED_RULES_DIR, ...userRulesDirs]) };
  } catch (error) {
    return { policy: bundled, warning: `Guardian could not load your rules files, so only its bundled rules apply: ${(error as Error).message}` };
  }
}

/**
 * Keeps the rules that last loaded when a reload fails, whether a file stopped parsing or became unreadable:
 * dropping them would silently remove your own `forbidden` rules. With nothing loaded before, the bundled
 * rules apply alone.
 */
export function retainPolicies(previous: LoadedPolicies | undefined, next: LoadedPolicies): LoadedPolicies {
  if (!next.warning || !previous || previous.warning) return next;
  return { ...previous, warning: `${next.warning}; keeping the rules that last loaded` };
}

/**
 * The bundled policy followed by the user's extra policy. The Railway deny falls back to its built-in
 * text, so an unreadable or edited bundled file cannot drop it from the reviewer's instructions.
 */
export async function extraPolicy(userExtraPolicy: string | undefined, bundledPath = BUNDLED_EXTRA_POLICY_PATH): Promise<string> {
  let bundled: string;
  try {
    bundled = await readFile(bundledPath, 'utf8');
  } catch {
    bundled = RAILWAY_EXTRA_POLICY;
  }
  if (!bundled.includes('Railway')) bundled = `${RAILWAY_EXTRA_POLICY}\n\n${bundled}`;
  return userExtraPolicy?.trim() ? `${bundled.trim()}\n\n${userExtraPolicy.trim()}` : bundled.trim();
}

/**
 * A prefix rule is only persisted when it cannot widen a boundary: Railway stays out of reach, and Codex's
 * banned suggestions (bare interpreters, `env`, `sudo`, `git`, `rm`) never become standing allow rules.
 */
export function persistableAmendment(shell: Shell, prefix: readonly string[]): string[] | undefined {
  if (!prefix.length) return undefined;
  if (isRailwayProgram(prefix[0]) || railwayDecision(shell, [...prefix]) !== undefined) return undefined;
  const sameTokens = (banned: readonly string[]) => banned.length === prefix.length && banned.every((token, index) => token === prefix[index]);
  if (BANNED_PREFIX_SUGGESTIONS.some(sameTokens)) return undefined;
  // A wrapper prefix allows every command it can carry, so it is never a reusable rule.
  if (WRAPPER_PREFIXES.has(prefix[0].split('/').pop() ?? prefix[0])) return undefined;
  return [...prefix];
}

const WRAPPER_PREFIXES = new Set(['command', 'exec', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'setsid', 'xargs', 'watch', 'find', 'env', 'sudo', 'doas', 'eval', 'script', 'ssh', 'make', 'just', 'task']);
