// Approval routing ported from openai/codex codex-rs/ext/guardian-reviewer/src/{routing,review}.rs,
// codex-rs/core/src/tools/approvals.rs and codex-rs/core/src/context/guardian_approved_action.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. When a review times out or fails, Guardian asks you by default
// (`autoReview.failureFallback`); Codex rejects to the agent.
import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { GuardianConfig } from './config.ts';
import type { GuardianAssessment } from './review/assessment.ts';
import { ReviewDenials } from './review/circuit-breaker.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX, truncateText } from './review/context.ts';
import { completeReview, type ReviewContextHashes, type ReviewError, type ReviewOutcome } from './review/outcome.ts';

const MAX_APPROVAL_REASON_TOKENS = 512;
export const MAX_REVIEWED_ACTION_BYTES = 256 * 1024;
const NO_INTERACTIVE_USER = 'approval required, but no interactive user is available to approve it';
const USER_REJECTED = 'rejected by user';
const REVIEW_CANCELLED = 'automatic approval review was cancelled';
const YES = 'Yes, proceed';
const NO = 'No, and tell the agent what to do differently';
export const APPROVAL_AUDIT_ENTRY_TYPE = 'guardian-approval-decision';

export interface ApprovalRequest {
  /** The planned action exactly as the reviewer sees it. */
  action: Record<string, unknown>;
  /** Use safe persisted metadata, omit free text/hashes, clear manual replay, and display the complete action to human reviewers. */
  audit?: { action: Record<string, unknown>; summary: string };
  /** One line shown to you when you are asked. */
  summary: string;
  /** The agent's approval question, shown to you above the summary. */
  justification?: string;
  /** Why approval is needed: a policy justification or a retry reason. */
  reason?: string;
  /** Prefix rule you may persist so similar commands skip approval. */
  amendment?: string[];
}

export type ApprovalDecision =
  | { type: 'approved'; persist?: string[] }
  | { type: 'rejected'; message: string }
  | { type: 'aborted'; message: string };

export interface ApprovalAuditEntry {
  version: 1;
  requestId: string;
  timestamp: string;
  sessionId: string;
  sessionLeafId: string | null;
  actionJson: string;
  actionBytes: number;
  actionTruncated: boolean;
  actionRedacted?: boolean;
  summary: string;
  requestReason?: string;
  justification?: string;
  approvalPolicy: GuardianConfig['approvalPolicy'];
  decider: 'auto_review' | 'user' | 'policy';
  verdict: 'approved' | 'rejected' | 'aborted' | 'error';
  rationale: string;
  durationMs: number;
  reviewer?: GuardianConfig['reviewer'];
  assessment?: GuardianAssessment;
  contextHashes?: ReviewContextHashes;
  userChoice?: 'approve' | 'approve_and_persist' | 'reject' | 'dismiss' | 'manual';
  requestedRule?: string[];
}

type AuditDecision = Pick<ApprovalAuditEntry, 'decider' | 'verdict' | 'rationale' | 'assessment' | 'contextHashes' | 'userChoice' | 'requestedRule'> & { failureKind?: ReviewError['type'] | 'no_interactive_user' };
type AuditRequest = Omit<ApprovalAuditEntry, keyof AuditDecision | 'version' | 'timestamp' | 'durationMs' | 'reviewer' | 'sessionId' | 'sessionLeafId'>;

export interface ReviewInput {
  actionJson: string;
  reason?: string;
}

export interface ApprovalContext {
  hasUI: boolean;
  sessionManager: Pick<ExtensionContext['sessionManager'], 'getSessionId' | 'getLeafId'>;
  abort(): void;
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export interface ApprovalDeps {
  config(): GuardianConfig;
  review(input: ReviewInput, ctx: ApprovalContext, signal: AbortSignal | undefined): Promise<ReviewOutcome>;
  /** Identifies the agent turn for the denial circuit breaker. */
  turnId(): string;
  record(entry: ApprovalAuditEntry): void;
}

/** Sorted-key, two-space JSON like Codex's `format_guardian_action_pretty`. */
export function formatActionPretty(action: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(sort(action), null, 2);
}

/** Trusted approval of one previously rejected action, as Codex's `GuardianApprovedAction` renders it. */
export function manualApprovalMessage(approvedActionJson: string): string {
  return `${MANUAL_APPROVAL_DEVELOPER_PREFIX}\n\nTreat this as approval to perform that exact action in the same context in which it was originally requested.\nDo not assume this also authorizes similar operations with different payloads.\n\nApproved action:\n${approvedActionJson}`;
}

export interface DeniedAction {
  summary: string;
  actionJson: string;
}

export class Approvals {
  private readonly denials = new ReviewDenials();
  private denied: { action: DeniedAction; audit: AuditRequest } | undefined;

  constructor(private readonly deps: ApprovalDeps) {}

  /** Consumes the denial, so one approval cannot be replayed for a later action. */
  takeDenied(ctx: ApprovalContext): DeniedAction | undefined {
    const started = performance.now();
    const denied = this.denied;
    if (!denied) return undefined;
    this.record(denied.audit, { decider: 'user', verdict: 'approved', rationale: 'Approved with /guardian approve.', userChoice: 'manual' }, ctx, performance.now() - started, this.deps.config());
    this.denied = undefined;
    return denied.action;
  }

  clearDenied(): void {
    this.denied = undefined;
  }

  clearTurn(turnId: string): void {
    this.denials.clearTurn(turnId);
  }

  async request(request: ApprovalRequest, ctx: ApprovalContext, signal?: AbortSignal): Promise<ApprovalDecision> {
    const config = this.deps.config();
    if (request.audit) this.clearDenied();
    const actionJson = formatActionPretty(request.action);
    const actionBytes = Buffer.byteLength(actionJson);
    const audit: AuditRequest = {
      requestId: randomUUID(), actionJson: request.audit ? formatActionPretty(request.audit.action) : truncateText(actionJson, MAX_REVIEWED_ACTION_BYTES / 4), actionBytes,
      ...(request.audit ? { actionRedacted: true } : {}),
      actionTruncated: actionBytes > MAX_REVIEWED_ACTION_BYTES, summary: truncateText(request.audit?.summary ?? request.summary, MAX_APPROVAL_REASON_TOKENS), approvalPolicy: config.approvalPolicy,
      ...(request.audit || request.reason === undefined ? {} : { requestReason: truncateText(request.reason, MAX_APPROVAL_REASON_TOKENS) }),
      ...(request.audit || request.justification === undefined ? {} : { justification: truncateText(request.justification, MAX_APPROVAL_REASON_TOKENS) }),
    };
    let started = performance.now();
    const record = (decision: AuditDecision) => {
      const now = performance.now();
      const { failureKind, ...persistedDecision } = decision;
      this.record(audit, request.audit ? {
        decider: decision.decider, verdict: decision.verdict, rationale: `Connector action ${decision.verdict}${failureKind ? ` (${failureKind})` : ''}.`,
        ...(decision.userChoice ? { userChoice: decision.userChoice } : {}),
      } : persistedDecision, ctx, now - started, config);
      started = now;
    };
    if (config.approvalsReviewer !== 'auto_review' || config.approvalPolicy !== 'on-request') return this.askUser(request, ctx, record);
    if (actionBytes > MAX_REVIEWED_ACTION_BYTES) {
      const message = `This action is too large to review completely (${actionBytes} bytes, limit ${MAX_REVIEWED_ACTION_BYTES}). Split it into smaller changes and retry.`;
      record({ decider: 'policy', verdict: 'rejected', rationale: message });
      return { type: 'rejected', message };
    }
    const reason = request.reason === undefined ? undefined : truncateText(request.reason, MAX_APPROVAL_REASON_TOKENS);
    let outcome: ReviewOutcome;
    try {
      outcome = await this.deps.review({ actionJson, ...(reason === undefined ? {} : { reason }) }, ctx, signal);
    } catch (error) {
      // A review that fails to start or clean up is a failed review, so it takes the same fallback.
      outcome = signal?.aborted ? { type: 'error', error: { type: 'cancelled' } }
        : { type: 'error', error: { type: 'session', message: error instanceof Error ? error.message : String(error), transient: false } };
    }
    const completion = completeReview(outcome);
    const automatic: AuditDecision = outcome.type === 'completed'
      ? { decider: 'auto_review', verdict: outcome.assessment.outcome === 'allow' ? 'approved' : 'rejected', rationale: outcome.assessment.rationale, assessment: outcome.assessment }
      : { decider: 'auto_review', verdict: outcome.error.type === 'cancelled' ? 'aborted' : 'error', rationale: completion.warning ?? REVIEW_CANCELLED, failureKind: outcome.error.type };
    if (outcome.contextHashes) automatic.contextHashes = outcome.contextHashes;
    const turnId = this.deps.turnId();
    if (completion.assessmentOutcome === 'deny') {
      this.denied = request.audit ? undefined : { action: { summary: request.summary, actionJson }, audit };
      ctx.ui.notify(completion.warning!, 'warning');
      const interrupt = this.denials.recordDenial(turnId);
      if (interrupt) {
        ctx.ui.notify(interrupt, 'warning');
        ctx.abort();
      }
    } else {
      this.denials.recordNonDenial(turnId);
    }
    record(automatic);
    const { decision } = completion;
    switch (decision.type) {
      case 'approved': return { type: 'approved' };
      case 'abort': return { type: 'aborted', message: REVIEW_CANCELLED };
      default: {
        if (completion.assessmentOutcome === 'deny') return { type: 'rejected', message: decision.message };
        if (config.autoReview.failureFallback === 'user' && ctx.hasUI) {
          ctx.ui.notify(`${completion.warning}; asking you instead.`, 'warning');
          return this.askUser(request, ctx, record);
        }
        record({ decider: 'policy', verdict: 'rejected', rationale: decision.message, ...(automatic.failureKind ? { failureKind: automatic.failureKind } : {}) });
        return { type: 'rejected', message: decision.message };
      }
    }
  }

  private record(audit: AuditRequest, decision: AuditDecision, ctx: ApprovalContext, durationMs: number, config: GuardianConfig): void {
    this.deps.record({
      ...audit, ...decision, version: 1, timestamp: new Date().toISOString(), durationMs: Math.max(0, Math.round(durationMs)),
      sessionId: ctx.sessionManager.getSessionId(), sessionLeafId: ctx.sessionManager.getLeafId(),
      ...(decision.decider === 'auto_review' ? { reviewer: { ...config.reviewer } } : {}),
    });
  }

  private async askUser(request: ApprovalRequest, ctx: ApprovalContext, record: (decision: AuditDecision) => void): Promise<ApprovalDecision> {
    if (!ctx.hasUI) {
      record({ decider: 'policy', verdict: 'rejected', rationale: NO_INTERACTIVE_USER, failureKind: 'no_interactive_user' });
      return { type: 'rejected', message: NO_INTERACTIVE_USER };
    }
    const always = request.amendment && `Yes, and don't ask again for commands that start with \`${request.amendment.join(' ')}\``;
    const options = always ? [YES, always, NO] : [YES, NO];
    const actionJson = request.audit && formatActionPretty(request.action);
    const actionDisplay = actionJson && actionJson.replace(/(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => {
      const code = char.codePointAt(0)!.toString(16);
      return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, '0')}`;
    });
    const title = [request.justification ?? 'Allow this action?', request.summary,
      ...(actionJson ? [`Complete action (${Buffer.byteLength(actionJson)} bytes):`, actionDisplay, request.summary] : []), request.reason].filter(Boolean).join('\n');
    const choice = await ctx.ui.select(title, options);
    const approved = choice === YES || Boolean(always && choice === always);
    try {
      record({ decider: 'user', verdict: approved ? 'approved' : 'aborted', rationale: choice ?? 'Approval prompt dismissed.',
        userChoice: choice === YES ? 'approve' : always && choice === always ? 'approve_and_persist' : choice === undefined ? 'dismiss' : 'reject',
        ...(always && choice === always ? { requestedRule: request.amendment } : {}),
      });
    } finally {
      if (!approved) ctx.abort();
    }
    if (choice === YES) return { type: 'approved' };
    if (always && choice === always) return { type: 'approved', persist: request.amendment };
    return { type: 'aborted', message: USER_REJECTED };
  }
}
