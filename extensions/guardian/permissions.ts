// Ported from openai/codex codex-rs/prompts/src/permissions_instructions.rs and format_allow_prefixes in
// codex-rs/protocol/src/models.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md. Host instructions are Pi-specific.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const template = (name: string) => readFileSync(join(import.meta.dirname, 'prompts', 'permissions', name), 'utf8');
const APPROVAL_POLICY_NEVER = template('never.md');
const APPROVAL_POLICY_UNLESS_TRUSTED = template('unless_trusted.md');
const APPROVAL_POLICY_ON_REQUEST = template('on_request.md');
const SANDBOX_TEMPLATES = {
  host: template('host.md').trimEnd(),
  'danger-full-access': template('danger_full_access.md').trimEnd(),
  'workspace-write': template('workspace_write.md').trimEnd(),
  'read-only': template('read_only.md').trimEnd(),
};

const AUTO_REVIEW_SUFFIX = '`approvals_reviewer` is `auto_review`: Sandbox escalations with require_escalated will be reviewed for compliance with the policy. If a rejection happens, you should proceed only with a materially safer alternative, or inform the user of the risk and send a final message to ask for approval.';
const APPROVED_PREFIXES = '## Approved command prefixes\nThe following prefix rules have already been approved: ';
export const MAX_PERMISSION_PATH_BYTES = 32 * 1024;
export const OMITTED_PERMISSION_PATHS = 'Additional permission paths/globs are omitted. All restrictions still apply; do not use escalation or additional permissions to bypass omitted read denials.';
const MAX_RENDERED_PREFIXES = 100;
const MAX_ALLOW_PREFIX_TEXT_CHARS = 5000;
const TRUNCATED_MARKER = '...\n[Some commands were truncated]';

export type SandboxMode = keyof typeof SANDBOX_TEMPLATES;
export type NetworkAccess = 'enabled' | 'restricted';
export type InstructedApprovalPolicy = 'never' | 'on-request' | 'unless-trusted';
export type ApprovalsReviewer = 'user' | 'auto_review';

export interface PermissionsRenderContext {
  sandboxMode: SandboxMode;
  networkAccess: NetworkAccess;
  approvalPolicy: InstructedApprovalPolicy;
  reviewer: ApprovalsReviewer;
  approvedCommandPrefixes: string[][];
  writableRoots: string[];
}

export function sandboxText(mode: SandboxMode, networkAccess: NetworkAccess): string {
  return SANDBOX_TEMPLATES[mode].replaceAll('{{ network_access }}', networkAccess);
}

export function formatAllowPrefixes(prefixes: string[][]): string | undefined {
  if (!prefixes.length) return undefined;
  const size = (prefix: string[]) => prefix.reduce((total, token) => total + Buffer.byteLength(token), 0);
  const compareTokens = (left: string[], right: string[]) => {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return left.length - right.length;
  };
  const sorted = [...prefixes].sort((left, right) => left.length - right.length || size(left) - size(right) || compareTokens(left, right));
  let output = sorted.slice(0, MAX_RENDERED_PREFIXES)
    .map(prefix => `- [${prefix.map(token => JSON.stringify(token)).join(', ')}]`).join('\n');
  let truncated = prefixes.length > MAX_RENDERED_PREFIXES;
  const chars = [...output];
  if (chars.length > MAX_ALLOW_PREFIX_TEXT_CHARS) {
    truncated = true;
    output = chars.slice(0, MAX_ALLOW_PREFIX_TEXT_CHARS).join('');
  }
  return truncated ? `${output}${TRUNCATED_MARKER}` : output;
}

export function approvalText(approvalPolicy: InstructedApprovalPolicy, reviewer: ApprovalsReviewer, approvedCommandPrefixes: string[][]): string {
  if (approvalPolicy === 'never') return APPROVAL_POLICY_NEVER;
  let text = APPROVAL_POLICY_UNLESS_TRUSTED;
  if (approvalPolicy === 'on-request') {
    const sections = [APPROVAL_POLICY_ON_REQUEST];
    const prefixes = formatAllowPrefixes(approvedCommandPrefixes);
    if (prefixes) sections.push(`${APPROVED_PREFIXES}${prefixes}`);
    text = sections.join('\n\n');
  }
  return reviewer === 'auto_review' ? `${text}\n\n${AUTO_REVIEW_SUFFIX}` : text;
}

function appendSection(text: string, section: string): string {
  return `${text.endsWith('\n') ? text : `${text}\n`}${section}`;
}

/** The body Codex places between `<permissions instructions>` markers. */
export function permissionsInstructions(context: PermissionsRenderContext): string {
  if (context.sandboxMode === 'host') {
    const approval = context.approvalPolicy === 'never'
      ? 'Approval policy is never: only commands allowed by an explicit rule may run; file changes are blocked.'
      : context.reviewer === 'auto_review' && context.approvalPolicy === 'on-request'
        ? '`approvals_reviewer` is `auto_review`: Guardian sends commands and file changes to its reviewer automatically unless a command rule decides them.'
        : 'Commands and file changes require user approval unless a command rule decides them.';
    const prefixes = formatAllowPrefixes(context.approvedCommandPrefixes);
    return `\n${sandboxText('host', 'enabled')}\n${approval}\nCall tools normally; omit sandbox_permissions. Do not bypass a rejected action. Continue independent authorized work while addressing the rejection.\n${prefixes ? `${APPROVED_PREFIXES}${prefixes}\n` : ''}`;
  }
  let remainingPathBytes = MAX_PERMISSION_PATH_BYTES - OMITTED_PERMISSION_PATHS.length - 1;
  let pathsOmitted = false;
  // Reserve up to ten bytes for each entry's label, quoting, and separator.
  const writableRoots = context.writableRoots.filter(path => {
    const cost = Buffer.byteLength(path) + 10;
    if (cost > remainingPathBytes) {
      pathsOmitted = true;
      return false;
    }
    remainingPathBytes -= cost;
    return true;
  });
  let text = '';
  const sandbox = sandboxText(context.sandboxMode, context.networkAccess);
  if (sandbox) text = appendSection(text, sandbox);
  text = appendSection(text, approvalText(context.approvalPolicy, context.reviewer, context.approvedCommandPrefixes));
  if (writableRoots.length) {
    const roots = writableRoots.map(root => `\`${root}\``);
    text = appendSection(text, roots.length === 1 ? ` The writable root is ${roots[0]}.` : ` The writable roots are ${roots.join(', ')}.`);
  }
  if (pathsOmitted) text = appendSection(text, OMITTED_PERMISSION_PATHS);
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function wrapPermissionsInstructions(body: string): string {
  return `<permissions instructions>${body}</permissions instructions>`;
}
