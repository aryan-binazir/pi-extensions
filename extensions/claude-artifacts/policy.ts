import { isDeepStrictEqual } from 'node:util';

/** One Artifact call the job needs. A first publish may also carry the one-word `icon` Claude adds on its own. */
export interface Step { input: Record<string, unknown>; icon?: boolean }
/** The calls a job may make, in order, and the staged file Claude may `Read` (an absolute path). */
export interface Plan { steps: readonly Step[]; readable?: string }
export interface PolicyState { next: number; denials: number; reserved: Map<string, number> }
export interface ToolCall { tool: string; input: Record<string, unknown>; id: string }
export type Decision = { allow: true; step: number | 'read' } | { allow: false; reason: string; fatal: boolean };

export const MAX_DENIALS = 3;
export const policyState = (): PolicyState => ({ next: 0, denials: 0, reserved: new Map() });

/** Allows only the next planned call, each once, and reads of the staged file; anything else is denied. */
export function decide(plan: Plan, state: PolicyState, call: ToolCall): Decision {
  if (call.tool === 'Read' && plan.readable && call.input.file_path === plan.readable && Object.keys(call.input).every(key => ['file_path', 'offset', 'limit'].includes(key))) return { allow: true, step: 'read' };
  const step = plan.steps[state.next];
  if (call.tool === 'Artifact' && step && !state.reserved.has(call.id) && matches(step, call.input)) {
    state.reserved.set(call.id, state.next);
    return { allow: true, step: state.next++ };
  }
  const reason = call.tool !== 'Artifact' ? 'Only the Artifact tool is available for this job.'
    : step ? `Call the Artifact tool with exactly ${JSON.stringify(step.input)}.` : 'The job is complete; do not call more tools.';
  return { allow: false, reason, fatal: ++state.denials >= MAX_DENIALS };
}

function matches(step: Step, input: Record<string, unknown>) {
  const extra = Object.keys(input).filter(key => !(key in step.input));
  const icon = (key: string) => step.icon === true && key === 'icon' && typeof input.icon === 'string' && /^[a-z][a-z-]{0,23}$/.test(input.icon);
  return Object.entries(step.input).every(([key, value]) => isDeepStrictEqual(input[key], value)) && extra.every(icon);
}
