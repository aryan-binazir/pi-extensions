// Where Guardian's preferences live. Mirrors Codex's `$CODEX_HOME/config.toml` and `$CODEX_HOME/rules/*.rules`
// (openai/codex codex-rs/core/src/exec_policy.rs @ ce0323f, Apache-2.0), plus rules and policy shared through this repo.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadExecPolicy } from './exec-policy.ts';
import type { Policy } from './rules.ts';

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
  policy: Policy;
  /** Set when user rules failed to parse; the bundled rules still apply. */
  warning?: string;
}

export async function loadPolicies(userRulesDirs: readonly string[]): Promise<LoadedPolicies> {
  const bundled = await loadExecPolicy([BUNDLED_RULES_DIR]);
  if (!userRulesDirs.length) return { policy: bundled };
  try {
    return { policy: await loadExecPolicy([BUNDLED_RULES_DIR, ...userRulesDirs]) };
  } catch (error) {
    return { policy: bundled, warning: `Guardian ignored your rules files: ${(error as Error).message}` };
  }
}

/** The bundled policy followed by the user's extra policy. */
export async function extraPolicy(userExtraPolicy: string | undefined): Promise<string> {
  const bundled = await readFile(BUNDLED_EXTRA_POLICY_PATH, 'utf8');
  return userExtraPolicy?.trim() ? `${bundled.trim()}\n\n${userExtraPolicy.trim()}` : bundled.trim();
}
