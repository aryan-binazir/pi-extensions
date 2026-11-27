import { isDeepStrictEqual } from 'node:util';

export interface Step { input: Record<string, unknown>; allowIcon?: boolean }
export interface Plan { steps: readonly Step[]; readableFile?: string }
interface ToolCall { tool: string; input: Record<string, unknown>; id: string }
type Decision = { allow: true } | { allow: false; reason: string; fatal: boolean };

const MAX_DENIALS = 3;

export class ArtifactToolError extends Error {
  readonly refused: boolean;
  constructor(readonly step: number, readonly detail: string) {
    super(`Claude Code's Artifact tool failed: ${detail}`);
    this.refused = /^(Publish refused|You hadn't viewed the live version)/.test(detail);
  }
}

export function createPolicy(plan: Plan) {
  const reserved = new Map<string, number>();
  let next = 0, denials = 0, awaiting: string | undefined;
  const deny = (reason: string): Decision => ({ allow: false, reason, fatal: ++denials >= MAX_DENIALS });
  const release = (id: string) => { if (awaiting === id) awaiting = undefined; };
  return {
    decide(call: ToolCall): Decision {
      if (call.tool === 'Read' && plan.readableFile && call.input.file_path === plan.readableFile && Object.keys(call.input).every(key => ['file_path', 'offset', 'limit'].includes(key))) return { allow: true };
      const step = plan.steps[next];
      if (call.tool === 'Artifact' && step && !reserved.has(call.id) && matches(step, call.input)) {
        if (awaiting !== undefined) return deny('Wait for the previous Artifact call\'s result, then make this call.');
        reserved.set(call.id, next++); awaiting = call.id;
        return { allow: true };
      }
      return deny(call.tool !== 'Artifact' ? 'Only the Artifact tool is available for this job.'
        : step ? `Call the Artifact tool with exactly ${JSON.stringify(step.input)}.` : 'The job is complete; do not call more tools.');
    },
    succeeded(id: string) {
      const step = reserved.get(id);
      if (step !== undefined) release(id);
      return step;
    },
    failed(id: string, error: unknown) {
      const step = reserved.get(id);
      if (step === undefined) return undefined;
      const failure = new ArtifactToolError(step, String(error ?? 'unknown error'));
      if (failure.refused) release(id);
      return failure;
    },
    publishOutcomeUnknown: () => awaiting !== undefined && plan.steps[reserved.get(awaiting)!].input.action === 'publish',
  };
}

function matches(step: Step, input: Record<string, unknown>) {
  const extra = Object.keys(input).filter(key => !Object.hasOwn(step.input, key));
  const isAllowedIcon = (key: string) => step.allowIcon === true && key === 'icon' && typeof input.icon === 'string' && /^[a-z][a-z-]{0,23}$/.test(input.icon);
  return Object.entries(step.input).every(([key, value]) => isDeepStrictEqual(input[key], value)) && extra.every(isAllowedIcon);
}
