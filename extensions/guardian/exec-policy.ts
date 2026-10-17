// Ported from openai/codex codex-rs/core/src/exec_policy.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// POSIX only: the Windows sandbox, PowerShell lowering, and requirements overlays have no counterpart here.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Decision, type Evaluation, type HeuristicsFallback, Policy, PolicyParser, type RuleMatch } from './rules.ts';
import type { DangerousCommandMatch, Shell } from './shell.ts';
import { renderShlexCommand } from './shlex.ts';

export const PROMPT_CONFLICT_REASON = 'approval required by policy, but AskForApproval is set to Never';
export const REJECT_SANDBOX_APPROVAL_REASON = 'approval required by policy, but AskForApproval::Granular.sandbox_approval is false';
export const REJECT_RULES_APPROVAL_REASON = 'approval required by policy rule, but AskForApproval::Granular.rules is false';
const RULE_EXTENSION = '.rules';

export const BANNED_PREFIX_SUGGESTIONS: readonly (readonly string[])[] = [
  ['/bin/bash'], ['/bin/bash', '-c'], ['/bin/bash', '-lc'], ['/bin/sh'], ['/bin/sh', '-c'], ['/bin/sh', '-lc'],
  ['/bin/zsh'], ['/bin/zsh', '-c'], ['/bin/zsh', '-lc'], ['Rscript'], ['bash'], ['bash', '-c'], ['bash', '-lc'],
  ['bun'], ['bun', '-e'], ['bun', 'run'], ['cmd'], ['cmd', '/c'], ['cmd', '/k'], ['cmd.exe'], ['cmd.exe', '/c'], ['cmd.exe', '/k'],
  ['dash'], ['dash', '-c'], ['deno'], ['deno', 'eval'], ['env'], ['fish'], ['fish', '-c'], ['git'], ['julia'], ['julia', '-e'],
  ['ksh'], ['ksh', '-c'], ['lua'], ['lua', '-e'], ['node'], ['node', '-e'], ['nodejs'], ['nodejs', '-e'], ['npm', 'run'],
  ['osascript'], ['perl'], ['perl', '-e'], ['php'], ['php', '-r'], ['pnpm', 'run'],
  ['powershell'], ['powershell', '-Command'], ['powershell', '-EncodedCommand'], ['powershell', '-File'], ['powershell', '-c'],
  ['powershell.exe'], ['powershell.exe', '-Command'], ['powershell.exe', '-EncodedCommand'], ['powershell.exe', '-File'], ['powershell.exe', '-c'],
  ['pwsh'], ['pwsh', '-Command'], ['pwsh', '-EncodedCommand'], ['pwsh', '-File'], ['pwsh', '-c'], ['pwsh', '-e'], ['pwsh', '-ec'], ['pwsh', '-f'],
  ['py'], ['py', '-3'], ['pypy'], ['pypy3'], ['python'], ['python', '-'], ['python', '-c'], ['python3'], ['python3', '-'], ['python3', '-c'],
  ['pythonw'], ['pyw'], ['rm'], ['ruby'], ['ruby', '-e'], ['sh'], ['sh', '-c'], ['sh', '-lc'], ['sudo'], ['yarn', 'run'],
  ['zsh'], ['zsh', '-c'], ['zsh', '-lc'],
];

export type ApprovalPolicy = 'never' | 'on-request' | 'unless-trusted' | { granular: { sandboxApproval: boolean; rules: boolean } };
/** `restricted` is a platform sandbox (read-only or workspace-write); `unrestricted` is danger-full-access. */
export type FileSystemSandboxKind = 'restricted' | 'unrestricted' | 'external';
export type SandboxPermissions = 'use_default' | 'require_escalated';

export interface ExecApprovalRequest {
  command: string[];
  /**
   * Command segments to evaluate instead of parsing `command`. Guardian uses this for mandatory rules so a
   * forbidden prefix is still found inside control flow and substitutions, as Codex finds hidden `rm -f`.
   */
  commands?: string[][];
  approvalPolicy: ApprovalPolicy;
  fileSystem: FileSystemSandboxKind;
  sandboxPermissions: SandboxPermissions;
  prefixRule?: string[];
}

export type ExecApprovalRequirement =
  | { type: 'skip'; bypassSandbox: boolean; proposedExecpolicyAmendment: string[] | undefined }
  | { type: 'needs_approval'; reason: string | undefined; proposedExecpolicyAmendment: string[] | undefined }
  | { type: 'forbidden'; reason: string };

export interface UnmatchedCommandContext {
  approvalPolicy: ApprovalPolicy;
  fileSystem: FileSystemSandboxKind;
  sandboxPermissions: SandboxPermissions;
}

const isPolicyMatch = (rule: RuleMatch) => rule.type === 'prefix';
const sameTokens = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((token, index) => token === right[index]);

/** Loads every `*.rules` file from each directory in order; a missing directory contributes nothing. */
export async function loadExecPolicy(rulesDirs: readonly string[]): Promise<Policy> {
  const parser = new PolicyParser();
  for (const dir of rulesDirs) {
    for (const path of await collectPolicyFiles(dir)) parser.parse(path, await readFile(path, 'utf8'));
  }
  return parser.build();
}

async function collectPolicyFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith(RULE_EXTENSION)).map(entry => join(dir, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Plain commands from a word-only `bash -lc` script; otherwise the original argv as one command. */
export function commandsForExecPolicy(shell: Shell, command: string[]): string[][] {
  const commands = shell.parseShellLcPlainCommands(command);
  return commands?.length ? commands : [command];
}

/** Returns why the approval policy refuses to surface a prompt, if it does. */
export function promptIsRejectedByPolicy(approvalPolicy: ApprovalPolicy, promptIsRule: boolean): string | undefined {
  if (approvalPolicy === 'never') return PROMPT_CONFLICT_REASON;
  if (typeof approvalPolicy === 'string') return undefined;
  if (promptIsRule) return approvalPolicy.granular.rules ? undefined : REJECT_RULES_APPROVAL_REASON;
  return approvalPolicy.granular.sandboxApproval ? undefined : REJECT_SANDBOX_APPROVAL_REASON;
}

/** Decision for a command no exec-policy rule matched. */
export function renderDecisionForUnmatchedCommand(shell: Shell, command: string[], context: UnmatchedCommandContext): Decision {
  // Dangerous commands never run without approval; with prompts disabled they are forbidden outright.
  if (shell.dangerousCommandMatch(command)) return context.approvalPolicy === 'never' ? 'forbidden' : 'prompt';
  if (context.approvalPolicy === 'never') return 'allow';
  if (context.approvalPolicy === 'unless-trusted') return 'prompt';
  // In a restricted sandbox, let the sandbox enforce limits unless the command asks to leave it.
  if (context.fileSystem !== 'restricted') return 'allow';
  return context.sandboxPermissions === 'use_default' ? 'allow' : 'prompt';
}

export function createExecApprovalRequirement(shell: Shell, policy: Policy, request: ExecApprovalRequest): ExecApprovalRequirement {
  const { command, approvalPolicy, prefixRule } = request;
  const commands = request.commands?.length ? request.commands : commandsForExecPolicy(shell, command);
  const fallback: HeuristicsFallback = cmd => renderDecisionForUnmatchedCommand(shell, cmd, request);
  const matchOptions = { resolveHostExecutables: true };
  const evaluation = policy.checkMultiple(commands, fallback, matchOptions);
  const requestedAmendment = deriveRequestedExecpolicyAmendmentFromPrefixRule(prefixRule, evaluation.matchedRules, policy, commands, fallback);
  const dangerousMatchFor = (decision: Decision) => {
    const heuristic = evaluation.matchedRules.find(rule => rule.type === 'heuristics' && rule.decision === decision);
    return heuristic?.type === 'heuristics' ? shell.dangerousCommandMatch(heuristic.command) : undefined;
  };

  if (evaluation.decision === 'forbidden') {
    return { type: 'forbidden', reason: deriveForbiddenReason(command, evaluation, dangerousMatchFor('forbidden')) };
  }
  if (evaluation.decision === 'prompt') {
    const promptIsRule = evaluation.matchedRules.some(rule => isPolicyMatch(rule) && rule.decision === 'prompt');
    const rejection = promptIsRejectedByPolicy(approvalPolicy, promptIsRule);
    if (rejection) {
      return { type: 'forbidden', reason: promptIsRule ? rejection : deriveRejectedPromptReason(rejection, dangerousMatchFor('prompt')) };
    }
    return {
      type: 'needs_approval',
      reason: derivePromptReason(command, evaluation),
      proposedExecpolicyAmendment: requestedAmendment ?? tryDeriveExecpolicyAmendmentForPromptRules(evaluation.matchedRules),
    };
  }
  return {
    type: 'skip',
    // Bypass the sandbox only when every parsed segment is explicitly allowed by a rule.
    bypassSandbox: commands.every(segment => policy.matchesForCommand(segment, undefined, matchOptions)
      .some(rule => isPolicyMatch(rule) && rule.decision === 'allow')),
    proposedExecpolicyAmendment: tryDeriveExecpolicyAmendmentForAllowRules(evaluation.matchedRules),
  };
}

/** The first heuristic prompt, unless a policy rule prompts (an amendment would not skip that rule). */
function tryDeriveExecpolicyAmendmentForPromptRules(matchedRules: RuleMatch[]): string[] | undefined {
  if (matchedRules.some(rule => isPolicyMatch(rule) && rule.decision === 'prompt')) return undefined;
  const heuristic = matchedRules.find(rule => rule.type === 'heuristics' && rule.decision === 'prompt');
  return heuristic?.type === 'heuristics' ? heuristic.command : undefined;
}

/** For bypassing the sandbox on similar commands later; none when a rule already matched. */
function tryDeriveExecpolicyAmendmentForAllowRules(matchedRules: RuleMatch[]): string[] | undefined {
  if (matchedRules.some(isPolicyMatch)) return undefined;
  const heuristic = matchedRules.find(rule => rule.type === 'heuristics' && rule.decision === 'allow');
  return heuristic?.type === 'heuristics' ? heuristic.command : undefined;
}

export function deriveRequestedExecpolicyAmendmentFromPrefixRule(
  prefixRule: string[] | undefined,
  matchedRules: RuleMatch[],
  policy: Policy,
  commands: string[][],
  fallback: HeuristicsFallback,
): string[] | undefined {
  if (!prefixRule?.length) return undefined;
  if (BANNED_PREFIX_SUGGESTIONS.some(banned => sameTokens(banned, prefixRule))) return undefined;
  // A rule already matched; another one might conflict or not apply.
  if (matchedRules.some(isPolicyMatch)) return undefined;
  return prefixRuleWouldApproveAllCommands(policy, prefixRule, commands, fallback) ? [...prefixRule] : undefined;
}

function prefixRuleWouldApproveAllCommands(policy: Policy, prefixRule: string[], commands: string[][], fallback: HeuristicsFallback): boolean {
  const amended = policy.clone();
  amended.addPrefixRule(prefixRule, 'allow');
  return commands.every(command => amended.check(command, fallback, { resolveHostExecutables: true }).decision === 'allow');
}

function mostSpecificPrefixMatch(evaluation: Evaluation, decision: Decision) {
  let best: Extract<RuleMatch, { type: 'prefix' }> | undefined;
  for (const rule of evaluation.matchedRules) {
    if (rule.type === 'prefix' && rule.decision === decision && (!best || rule.matchedPrefix.length >= best.matchedPrefix.length)) best = rule;
  }
  return best;
}

/** A reason only when a policy rule drove the prompt. */
function derivePromptReason(commandArgs: string[], evaluation: Evaluation): string | undefined {
  const rule = mostSpecificPrefixMatch(evaluation, 'prompt');
  if (!rule) return undefined;
  const command = renderShlexCommand(commandArgs);
  return rule.justification === undefined ? `\`${command}\` requires approval by policy` : `\`${command}\` requires approval: ${rule.justification}`;
}

function deriveForbiddenReason(commandArgs: string[], evaluation: Evaluation, dangerous: DangerousCommandMatch | undefined): string {
  const command = renderShlexCommand(commandArgs);
  const rule = mostSpecificPrefixMatch(evaluation, 'forbidden');
  if (rule?.justification !== undefined) return `\`${command}\` rejected: ${rule.justification}`;
  if (rule) return `\`${command}\` rejected: policy forbids commands starting with \`${renderShlexCommand(rule.matchedPrefix)}\``;
  return `\`${command}\` rejected: ${dangerous ? dangerousCommandRejectionReason(dangerous) : 'blocked by policy'}`;
}

export function deriveRejectedPromptReason(fallbackReason: string, dangerous: DangerousCommandMatch | undefined): string {
  return dangerous === 'forced_rm' ? dangerousCommandRejectionReason(dangerous) : fallbackReason;
}

function dangerousCommandRejectionReason(dangerous: DangerousCommandMatch): string {
  return dangerous === 'forced_rm' ? 'rm -f style commands are not permitted. Use a safer approach' : 'blocked by policy';
}
