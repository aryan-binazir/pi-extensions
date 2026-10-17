// Ported from openai/codex codex-rs/ext/guardian-reviewer/src/assessment.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.

export type GuardianRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type GuardianUserAuthorization = 'unknown' | 'low' | 'medium' | 'high';
export type GuardianAssessmentOutcome = 'allow' | 'deny';

export interface GuardianAssessment {
  riskLevel: GuardianRiskLevel;
  userAuthorization: GuardianUserAuthorization;
  outcome: GuardianAssessmentOutcome;
  rationale: string;
}

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const USER_AUTHORIZATIONS = ['unknown', 'low', 'medium', 'high'] as const;
const OUTCOMES = ['allow', 'deny'] as const;

export const GUARDIAN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    risk_level: { type: 'string', enum: RISK_LEVELS },
    user_authorization: { type: 'string', enum: USER_AUTHORIZATIONS },
    outcome: { type: 'string', enum: OUTCOMES },
    rationale: { type: 'string' },
  },
  required: ['outcome'],
};

export const GUARDIAN_OUTPUT_CONTRACT_PROMPT = `You may use read-only tool checks to gather any additional context you need before deciding. When you are ready to answer, your final message must be strict JSON.

For low-risk actions, give the final answer directly: {"outcome":"allow"}.

For anything else, use this JSON schema:
{
  "risk_level": "low" | "medium" | "high" | "critical",
  "user_authorization": "unknown" | "low" | "medium" | "high",
  "outcome": "allow" | "deny",
  "rationale": string
}`;

function field<T extends string>(payload: Record<string, unknown>, name: string, allowed: readonly T[]): T | undefined {
  const value = payload[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`unknown variant for \`${name}\`: ${JSON.stringify(value)}, expected one of ${allowed.map(item => `\`${item}\``).join(', ')}`);
  }
  return value as T;
}

function parsePayload(text: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('guardian assessment must be a JSON object');
  return payload as Record<string, unknown>;
}

/**
 * The model is asked for strict JSON, but a surrounding prose wrapper is tolerated so formatting
 * drift fails less noisily. Non-JSON output is still a review failure.
 */
export function parseGuardianAssessment(text: string): GuardianAssessment {
  let payload: Record<string, unknown>;
  try {
    payload = parsePayload(text);
  } catch {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || start >= end) throw new Error('guardian assessment was not valid JSON');
    payload = parsePayload(text.slice(start, end + 1));
  }
  const outcome = field(payload, 'outcome', OUTCOMES);
  if (!outcome) throw new Error('missing field `outcome`');
  const rationale = typeof payload.rationale === 'string' && payload.rationale.trim() ? payload.rationale : undefined;
  return {
    riskLevel: field(payload, 'risk_level', RISK_LEVELS) ?? (outcome === 'allow' ? 'low' : 'high'),
    userAuthorization: field(payload, 'user_authorization', USER_AUTHORIZATIONS) ?? 'unknown',
    outcome,
    rationale: rationale ?? (outcome === 'allow' ? 'Auto-review returned a low-risk allow decision.' : 'Auto-review returned a deny decision without a rationale.'),
  };
}
