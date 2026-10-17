// Where Guardian's preferences live. Mirrors Codex's `$CODEX_HOME/config.toml` and `$CODEX_HOME/rules/*.rules`
// (openai/codex codex-rs/core/src/exec_policy.rs @ ce0323f, Apache-2.0), plus rules and policy shared through this repo.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { BANNED_PREFIX_SUGGESTIONS, loadExecPolicy } from './exec-policy.ts';
import { invokesRailwayCli, railwayDecision, RAILWAY_EXTRA_POLICY } from './railway.ts';
import { Policy } from './rules.ts';
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
  /** Set when your rules or the bundled rules could not be loaded. */
  warning?: string;
  /** Your rules failed to load, so `policy` lacks them; a bundled-rules warning alone leaves this unset. */
  userRulesFailed?: boolean;
}

export async function loadPolicies(userRulesDirs: readonly string[], bundledRulesDir = BUNDLED_RULES_DIR): Promise<LoadedPolicies> {
  let bundled: Policy;
  try {
    bundled = await loadExecPolicy([bundledRulesDir]);
  } catch (error) {
    // Guardian must still start: the Railway boundary is in code, and your rules still load below.
    const warning = `Guardian could not load its bundled rules; the Railway boundary in code still applies: ${(error as Error).message}`;
    if (!userRulesDirs.length) return { policy: Policy.empty(), warning };
    try {
      return { policy: await loadExecPolicy([...userRulesDirs]), warning };
    } catch (userError) {
      return { policy: Policy.empty(), warning: `${warning}; your rules files did not load either: ${(userError as Error).message}`, userRulesFailed: true };
    }
  }
  if (!userRulesDirs.length) return { policy: bundled };
  try {
    return { policy: await loadExecPolicy([bundledRulesDir, ...userRulesDirs]) };
  } catch (error) {
    return { policy: bundled, warning: `Guardian could not load your rules files, so only its bundled rules apply: ${(error as Error).message}`, userRulesFailed: true };
  }
}

/**
 * Keeps the rules that last loaded when a reload fails, whether a file stopped parsing or became unreadable:
 * dropping them would silently remove your own `forbidden` rules. With nothing loaded before, the bundled
 * rules apply alone.
 */
export function retainPolicies(previous: LoadedPolicies | undefined, next: LoadedPolicies): LoadedPolicies {
  // Keep the previous policy only when it holds your rules and the new load lost them.
  if (!next.userRulesFailed || !previous || previous.userRulesFailed) return next;
  // `previous` may itself be retained from an earlier failure; its policy is still the last one that loaded.
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
  if (!bundled.includes(RAILWAY_EXTRA_POLICY)) bundled = `${RAILWAY_EXTRA_POLICY}\n\n${bundled}`;
  return userExtraPolicy?.trim() ? `${bundled.trim()}\n\n${userExtraPolicy.trim()}` : bundled.trim();
}

/**
 * A prefix rule is only persisted when it cannot widen a boundary: a prefix that invokes the Railway CLI, Codex's
 * banned suggestions (bare interpreters, `env`, `sudo`, `git`, `rm`) and wrapper commands never become standing
 * allow rules. Package runners such as `npm test` persist as in Codex; the Railway boundary is checked before rules.
 */
export function persistableAmendment(shell: Shell, prefix: readonly string[]): string[] | undefined {
  if (!prefix.length) return undefined;
  if (invokesRailwayCli(prefix) || railwayDecision(shell, [...prefix]) !== undefined) return undefined;
  const sameTokens = (banned: readonly string[]) => banned.length === prefix.length && banned.every((token, index) => token === prefix[index]);
  if (BANNED_PREFIX_SUGGESTIONS.some(sameTokens)) return undefined;
  // A wrapper prefix allows every command it can carry, so it is never a reusable rule.
  if (WRAPPER_PREFIXES.has(prefix[0].split('/').pop() ?? prefix[0])) return undefined;
  return [...prefix];
}

const WRAPPER_PREFIXES = new Set(['command', 'exec', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'setsid', 'xargs', 'watch', 'find', 'env', 'sudo', 'doas', 'eval', 'script', 'ssh', 'make', 'just', 'task']);
