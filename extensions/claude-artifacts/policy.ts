import { isDeepStrictEqual } from 'node:util';

export interface Step { input: Record<string, unknown>; allowIcon?: boolean }
export interface Plan { steps: readonly Step[]; readableFile?: string }
interface PolicyState { next: number; denials: number; reserved: Map<string, number>; awaiting?: string }
interface ToolCall { tool: string; input: Record<string, unknown>; id: string }
type Decision = { allow: true; step: number | 'read' } | { allow: false; reason: string; fatal: boolean };

const MAX_DENIALS = 3;
export const policyState = (): PolicyState => ({ next: 0, denials: 0, reserved: new Map() });

export function decide(plan: Plan, state: PolicyState, call: ToolCall): Decision {
  if (call.tool === 'Read' && plan.readableFile && call.input.file_path === plan.readableFile && Object.keys(call.input).every(key => ['file_path', 'offset', 'limit'].includes(key))) return { allow: true, step: 'read' };
  const step = plan.steps[state.next];
  if (call.tool === 'Artifact' && step && !state.reserved.has(call.id) && matches(step, call.input)) {
    if (state.awaiting !== undefined) return { allow: false, reason: 'Wait for the previous Artifact call\'s result, then make this call.', fatal: ++state.denials >= MAX_DENIALS };
    state.reserved.set(call.id, state.next); state.awaiting = call.id;
    return { allow: true, step: state.next++ };
  }
  const reason = call.tool !== 'Artifact' ? 'Only the Artifact tool is available for this job.'
    : step ? `Call the Artifact tool with exactly ${JSON.stringify(step.input)}.` : 'The job is complete; do not call more tools.';
  return { allow: false, reason, fatal: ++state.denials >= MAX_DENIALS };
}

export function resolveStep(state: PolicyState, id: string) {
  if (state.awaiting === id) state.awaiting = undefined;
}

function matches(step: Step, input: Record<string, unknown>) {
  const extra = Object.keys(input).filter(key => !Object.hasOwn(step.input, key));
  const isAllowedIcon = (key: string) => step.allowIcon === true && key === 'icon' && typeof input.icon === 'string' && /^[a-z][a-z-]{0,23}$/.test(input.icon);
  return Object.entries(step.input).every(([key, value]) => isDeepStrictEqual(input[key], value)) && extra.every(isAllowedIcon);
}
