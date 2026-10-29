// Guardian's user preferences, named after the Codex settings they mirror (`approval_policy`, `approvals_reviewer`,
// `[auto_review]`, `sandbox_mode`, `[sandbox_workspace_write]`; openai/codex @ ce0323f, Apache-2.0). Codex picks its
// reviewer from a model catalog; here a GPT or other model in Pi's registry reviews, or Claude through `claude -p`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-ai';

/** Codex's `AskForApproval`; its config value for `unless-trusted` is `untrusted`, which is accepted too. */
export type ApprovalPolicy = 'on-request' | 'never' | 'unless-trusted';
export type ApprovalsReviewer = 'auto_review' | 'user';
export type SandboxMode = 'host' | 'workspace-write' | 'read-only' | 'danger-full-access';

/** Reviews with Claude Code's `claude -p` instead of a model in Pi's registry. */
export const CLAUDE_CLI_PROVIDER = 'claude-cli';

/** Emitted on Pi's event bus as `{ enabled }` when `/guardian on|off|toggle` overrides `enabled` for this session. */
export const GUARDIAN_ENABLED_EVENT = 'guardian:enabled';

export interface ReviewerModel {
  /** A provider in Pi's model registry, or `claude-cli` for Claude Code's print mode. */
  provider: string;
  model: string;
  reasoning: ThinkingLevel;
}

export interface GuardianConfig {
  enabled: boolean;
  approvalPolicy: ApprovalPolicy;
  /** Who reviews approval requests: the reviewer model, or you. */
  approvalsReviewer: ApprovalsReviewer;
  reviewer: ReviewerModel;
  connectors: { readOnly: string[]; alwaysReview: string[] };
  autoReview: {
    /** Replaces Guardian's built-in tenant policy. */
    policy: string | undefined;
    /** Fills the policy template's `{{ extra_policy }}` slot. */
    extraPolicy: string | undefined;
    /** When a review times out or fails: ask you (when a UI is available), or reject to the agent as Codex does. */
    failureFallback: 'user' | 'reject';
  };
  sandbox: { mode: SandboxMode; networkAccess: boolean; writableRoots: string[]; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
}

/** Host execution reviewed by Luna at low effort. */
export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  enabled: true,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'auto_review',
  connectors: { readOnly: [], alwaysReview: [] },
  reviewer: { provider: 'openai-codex', model: 'gpt-6-luna~fast', reasoning: 'low' },
  autoReview: { policy: undefined, extraPolicy: undefined, failureFallback: 'user' },
  sandbox: { mode: 'host', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false },
};

/**
 * Used while config.json is invalid and no valid settings have been read yet: Guardian stays on with its
 * strictest sandbox, and nothing is approved automatically.
 */
export const FAIL_CLOSED_CONFIG: GuardianConfig = {
  ...DEFAULT_GUARDIAN_CONFIG,
  approvalPolicy: 'unless-trusted',
  sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'read-only' },
};

const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const KNOWN_KEYS: Record<string, readonly string[]> = {
  config: ['enabled', 'approvalPolicy', 'approvalsReviewer', 'reviewer', 'autoReview', 'sandbox', 'connectors'],
  connectors: ['readOnly', 'alwaysReview'],
  reviewer: ['provider', 'model', 'reasoning'],
  autoReview: ['policy', 'policyFile', 'extraPolicy', 'extraPolicyFile', 'failureFallback'],
  sandbox: ['mode', 'networkAccess', 'writableRoots', 'excludeTmpdirEnvVar', 'excludeSlashTmp'],
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const prefix = field === 'config' ? '' : `${field}.`;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS[field].includes(key)) throw new Error(`unknown setting \`${prefix}${key}\``);
  }
  return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function text(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be true or false`);
  return value;
}

/** Inline text or a file path relative to the config directory; never both. */
function policyText(section: Record<string, unknown>, name: 'policy' | 'extraPolicy', configDir: string): string | undefined {
  const inline = section[name], file = section[`${name}File`];
  if (inline !== undefined && file !== undefined) throw new Error(`set only one of autoReview.${name} and autoReview.${name}File`);
  if (inline !== undefined) return text(inline, `autoReview.${name}`, '');
  if (file === undefined) return undefined;
  const path = resolve(configDir, text(file, `autoReview.${name}File`, ''));
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`autoReview.${name}File: cannot read ${path}: ${(error as Error).message}`);
  }
}

/** Reads Guardian's config file; a missing file means the defaults. */
export function loadGuardianConfig(path: string): GuardianConfig {
  if (!existsSync(path)) return DEFAULT_GUARDIAN_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${path}: ${(error as Error).message}`);
  }
  const config = object(raw, 'config');
  const reviewer = object(config.reviewer, 'reviewer'), autoReview = object(config.autoReview, 'autoReview'), sandbox = object(config.sandbox, 'sandbox');
  const defaults = DEFAULT_GUARDIAN_CONFIG;
  const connectors = object(config.connectors, 'connectors');
  const connectorNames = (key: 'readOnly' | 'alwaysReview'): string[] => {
    const value = connectors[key] ?? [];
    if (!Array.isArray(value) || value.length > 1024 || value.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(name))) {
      throw new Error(`connectors.${key} must be a list of at most 1024 exact tool names`);
    }
    return value;
  };
  const writableRoots = sandbox.writableRoots ?? [];
  if (!Array.isArray(writableRoots) || writableRoots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('sandbox.writableRoots must be a list of absolute paths');
  }
  const configDir = dirname(path);
  // The bridge only serves prompts from Pi's own agent lifecycle, so it cannot answer a review.
  if (reviewer.provider === 'claude-bridge') throw new Error('reviewer.provider claude-bridge cannot run reviews; use "claude-cli" to review with Claude');
  const approvalPolicy = oneOf(config.approvalPolicy, ['on-request', 'never', 'untrusted', 'unless-trusted'], 'approvalPolicy', defaults.approvalPolicy);
  return {
    enabled: boolean(config.enabled, 'enabled', defaults.enabled),
    approvalPolicy: approvalPolicy === 'untrusted' ? 'unless-trusted' : approvalPolicy,
    connectors: { readOnly: connectorNames('readOnly'), alwaysReview: connectorNames('alwaysReview') },
    approvalsReviewer: oneOf(config.approvalsReviewer, ['auto_review', 'user'], 'approvalsReviewer', defaults.approvalsReviewer),
    reviewer: {
      provider: text(reviewer.provider, 'reviewer.provider', defaults.reviewer.provider),
      model: text(reviewer.model, 'reviewer.model', defaults.reviewer.model),
      reasoning: oneOf(reviewer.reasoning, THINKING_LEVELS, 'reviewer.reasoning', defaults.reviewer.reasoning),
    },
    autoReview: {
      policy: policyText(autoReview, 'policy', configDir),
      extraPolicy: policyText(autoReview, 'extraPolicy', configDir),
      failureFallback: oneOf(autoReview.failureFallback, ['user', 'reject'], 'autoReview.failureFallback', defaults.autoReview.failureFallback),
    },
    sandbox: {
      mode: oneOf(sandbox.mode, ['host', 'workspace-write', 'read-only', 'danger-full-access'], 'sandbox.mode',
        config.sandbox === undefined ? defaults.sandbox.mode : 'workspace-write'),
      networkAccess: boolean(sandbox.networkAccess, 'sandbox.networkAccess', defaults.sandbox.networkAccess),
      writableRoots: writableRoots as string[],
      excludeTmpdirEnvVar: boolean(sandbox.excludeTmpdirEnvVar, 'sandbox.excludeTmpdirEnvVar', defaults.sandbox.excludeTmpdirEnvVar),
      excludeSlashTmp: boolean(sandbox.excludeSlashTmp, 'sandbox.excludeSlashTmp', defaults.sandbox.excludeSlashTmp),
    },
  };
}

const sanitizeTerminalLabel = (value: string) => value.replace(/[^a-zA-Z0-9._:/~+-]/g, '?').slice(0, 64);
const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);

/** Short family name for the footer: `Luna`, `Sol`, `Opus`, `Sonnet`, or the sanitized model id. */
export function reviewerLabel(reviewer: Pick<ReviewerModel, 'provider' | 'model'>): string {
  const id = reviewer.model.replace(/~.*$/, '');
  const family = /^gpt-[\d.]+-([a-z]+)$/.exec(id)?.[1] ?? /^claude-([a-z]+)-/.exec(id)?.[1];
  return family ? capitalize(family) : sanitizeTerminalLabel(reviewer.model);
}

/** The footer's top-right indicator. */
export function guardianStatusText(config: GuardianConfig, sandboxAvailable: boolean): string {
  if (!config.enabled) return 'Auto: off';
  // Codex sends only on-request approvals to the reviewer model; `untrusted` asks you, and `never` asks no one.
  const reviewer = config.approvalPolicy === 'never' ? 'no approvals'
    : config.approvalsReviewer === 'user' || config.approvalPolicy !== 'on-request' ? 'you review'
      : `${reviewerLabel(config.reviewer)} ${sanitizeTerminalLabel(config.reviewer.reasoning)}`;
  const sandbox = config.sandbox.mode === 'host' ? ' · host'
    : config.sandbox.mode === 'danger-full-access' || !sandboxAvailable ? ' · no sandbox' : config.sandbox.networkAccess ? ' · network' : '';
  return `Auto: on · ${reviewer}${sandbox}`;
}
