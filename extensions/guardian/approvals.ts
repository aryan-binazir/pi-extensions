// Approval routing ported from openai/codex codex-rs/ext/guardian-reviewer/src/{routing,review}.rs,
// codex-rs/core/src/tools/approvals.rs and codex-rs/core/src/context/guardian_approved_action.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. When a review times out or fails, Guardian asks you by default
// (`autoReview.failureFallback`); Codex rejects to the agent.
import { randomUUID } from 'node:crypto';
import type { GuardianConfig } from './config.ts';
import type { GuardianAssessment } from './review/assessment.ts';
import { ReviewDenials } from './review/circuit-breaker.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX, truncateText } from './review/context.ts';
import { completeReview, type ReviewOutcome } from './review/outcome.ts';

const MAX_APPROVAL_REASON_TOKENS = 512;
const MAX_REVIEWED_ACTION_BYTES = 256 * 1024;
const NO_INTERACTIVE_USER = 'approval required, but no interactive user is available to approve it';
const USER_REJECTED = 'rejected by user';
const YES = 'Yes, proceed';
const NO = 'No, and tell the agent what to do differently';
export const APPROVAL_AUDIT_ENTRY_TYPE = 'guardian-approval-decision';

export interface ApprovalRequest {
  /** The planned action exactly as the reviewer sees it. */
  action: Record<string, unknown>;
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
  actionJson: string;
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
  contextSha256?: string;
}

type AuditDecision = Pick<ApprovalAuditEntry, 'decider' | 'verdict' | 'rationale' | 'assessment' | 'contextSha256'>;
type AuditRequest = Omit<ApprovalAuditEntry, keyof AuditDecision | 'version' | 'timestamp' | 'durationMs' | 'reviewer'>;

export interface ReviewInput {
  actionJson: string;
  reason?: string;
}

export interface ApprovalContext {
  hasUI: boolean;
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
  record(entry: ApprovalAuditEntry, ctx: ApprovalContext): void;
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

  lastDenied(): DeniedAction | undefined {
    return this.denied?.action;
  }

  /** Consumes the denial, so one approval cannot be replayed for a later action. */
  takeDenied(ctx: ApprovalContext): DeniedAction | undefined {
    const denied = this.denied;
    if (!denied) return undefined;
    this.record(denied.audit, { decider: 'user', verdict: 'approved', rationale: 'Approved with /guardian approve.' }, ctx, 0, this.deps.config());
    this.denied = undefined;
    return denied.action;
  }

  clearTurn(turnId: string): void {
    this.denials.clearTurn(turnId);
  }

  async request(request: ApprovalRequest, ctx: ApprovalContext, signal?: AbortSignal): Promise<ApprovalDecision> {
    const config = this.deps.config();
    const actionJson = formatActionPretty(request.action);
    const audit: AuditRequest = {
      requestId: randomUUID(), actionJson, summary: request.summary, approvalPolicy: config.approvalPolicy,
      ...(request.reason === undefined ? {} : { requestReason: request.reason }),
      ...(request.justification === undefined ? {} : { justification: request.justification }),
    };
    let started = performance.now();
    const record = (decision: AuditDecision) => {
      const now = performance.now();
      this.record(audit, decision, ctx, now - started, config);
      started = now;
    };
    // Codex routes only on-request approvals to the auto reviewer.
    if (config.approvalsReviewer !== 'auto_review' || config.approvalPolicy !== 'on-request') return this.askUser(request, ctx, record);
    // The reviewer must see the whole action it approves; one this large is split by the agent instead.
    if (Buffer.byteLength(actionJson) > MAX_REVIEWED_ACTION_BYTES) {
      const message = `This action is too large to review completely (${Buffer.byteLength(actionJson)} bytes, limit ${MAX_REVIEWED_ACTION_BYTES}). Split it into smaller changes and retry.`;
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
    record({ ...(outcome.type === 'completed'
      ? { decider: 'auto_review', verdict: outcome.assessment.outcome === 'allow' ? 'approved' : 'rejected', rationale: outcome.assessment.rationale, assessment: outcome.assessment }
      : { decider: 'auto_review', verdict: outcome.error.type === 'cancelled' ? 'aborted' : 'error', rationale: completion.warning ?? 'automatic approval review was cancelled' }),
    ...(outcome.contextSha256 === undefined ? {} : { contextSha256: outcome.contextSha256 }) });
    const turnId = this.deps.turnId();
    if (completion.assessmentOutcome === 'deny') {
      this.denied = { action: { summary: request.summary, actionJson }, audit };
      ctx.ui.notify(completion.warning!, 'warning');
      const interrupt = this.denials.recordDenial(turnId);
      if (interrupt) {
        ctx.ui.notify(interrupt, 'warning');
        ctx.abort();
      }
    } else {
      this.denials.recordNonDenial(turnId);
    }
    const { decision } = completion;
    switch (decision.type) {
      case 'approved': return { type: 'approved' };
      case 'abort': return { type: 'aborted', message: 'automatic approval review was cancelled' };
      default: {
        if (completion.assessmentOutcome === 'deny') return { type: 'rejected', message: decision.message };
        if (config.autoReview.failureFallback === 'user' && ctx.hasUI) {
          ctx.ui.notify(`${completion.warning}; asking you instead.`, 'warning');
          return this.askUser(request, ctx, record);
        }
        return { type: 'rejected', message: decision.message };
      }
    }
  }

  private record(audit: AuditRequest, decision: AuditDecision, ctx: ApprovalContext, durationMs: number, config: GuardianConfig): void {
    this.deps.record({
      ...audit, ...decision, version: 1, timestamp: new Date().toISOString(), durationMs: Math.max(0, Math.round(durationMs)),
      ...(decision.decider === 'auto_review' ? { reviewer: { ...config.reviewer } } : {}),
    }, ctx);
  }

  private async askUser(request: ApprovalRequest, ctx: ApprovalContext, record: (decision: AuditDecision) => void): Promise<ApprovalDecision> {
    if (!ctx.hasUI) {
      record({ decider: 'policy', verdict: 'rejected', rationale: NO_INTERACTIVE_USER });
      return { type: 'rejected', message: NO_INTERACTIVE_USER };
    }
    const always = request.amendment && `Yes, and don't ask again for commands that start with \`${request.amendment.join(' ')}\``;
    const options = always ? [YES, always, NO] : [YES, NO];
    const title = [request.justification ?? 'Allow this action?', request.summary, request.reason].filter(Boolean).join('\n');
    const choice = await ctx.ui.select(title, options);
    record({ decider: 'user', verdict: choice === YES || (always && choice === always) ? 'approved' : 'aborted', rationale: choice ?? 'Approval prompt dismissed.' });
    if (choice === YES) return { type: 'approved' };
    if (always && choice === always) return { type: 'approved', persist: request.amendment };
    // Codex aborts the turn so you can tell the agent what to do differently.
    ctx.abort();
    return { type: 'aborted', message: USER_REJECTED };
  }
}
