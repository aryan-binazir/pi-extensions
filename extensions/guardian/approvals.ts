// Approval routing ported from openai/codex codex-rs/ext/guardian-reviewer/src/{routing,review}.rs,
// codex-rs/core/src/tools/approvals.rs and codex-rs/core/src/context/guardian_approved_action.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. When a review times out or fails, Guardian asks you by default
// (`autoReview.failureFallback`); Codex rejects to the agent.
import type { GuardianConfig } from './config.ts';
import { ReviewDenials } from './review/circuit-breaker.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX, truncateText } from './review/context.ts';
import { completeReview, type ReviewOutcome } from './review/outcome.ts';

const MAX_APPROVAL_REASON_TOKENS = 512;
const NO_INTERACTIVE_USER = 'approval required, but no interactive user is available to approve it';
const USER_REJECTED = 'rejected by user';
const YES = 'Yes, proceed';
const NO = 'No, and tell the agent what to do differently';

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
  private denied: DeniedAction | undefined;

  constructor(private readonly deps: ApprovalDeps) {}

  lastDenied(): DeniedAction | undefined {
    return this.denied;
  }

  clearTurn(turnId: string): void {
    this.denials.clearTurn(turnId);
  }

  async request(request: ApprovalRequest, ctx: ApprovalContext, signal?: AbortSignal): Promise<ApprovalDecision> {
    const config = this.deps.config();
    // Codex routes only on-request approvals to the auto reviewer.
    if (config.approvalsReviewer !== 'auto_review' || config.approvalPolicy !== 'on-request') return this.askUser(request, ctx);
    const actionJson = formatActionPretty(request.action);
    const reason = request.reason === undefined ? undefined : truncateText(request.reason, MAX_APPROVAL_REASON_TOKENS);
    const completion = completeReview(await this.deps.review({ actionJson, ...(reason === undefined ? {} : { reason }) }, ctx, signal));
    const turnId = this.deps.turnId();
    if (completion.assessmentOutcome === 'deny') {
      this.denied = { summary: request.summary, actionJson };
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
          return this.askUser(request, ctx);
        }
        return { type: 'rejected', message: decision.message };
      }
    }
  }

  private async askUser(request: ApprovalRequest, ctx: ApprovalContext): Promise<ApprovalDecision> {
    if (!ctx.hasUI) return { type: 'rejected', message: NO_INTERACTIVE_USER };
    const always = request.amendment && `Yes, and don't ask again for commands that start with \`${request.amendment.join(' ')}\``;
    const options = always ? [YES, always, NO] : [YES, NO];
    const title = [request.justification ?? 'Allow this action?', request.summary, request.reason].filter(Boolean).join('\n');
    const choice = await ctx.ui.select(title, options);
    if (choice === YES) return { type: 'approved' };
    if (always && choice === always) return { type: 'approved', persist: request.amendment };
    // Codex aborts the turn so you can tell the agent what to do differently.
    ctx.abort();
    return { type: 'aborted', message: USER_REJECTED };
  }
}
