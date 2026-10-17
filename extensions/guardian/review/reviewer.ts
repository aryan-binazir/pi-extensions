// The reviewer turn that stands in for Codex's Guardian review session (openai/codex codex-rs/core/src/guardian/
// {review_session,reviewer_config}.rs and codex-rs/ext/guardian-reviewer/src/{execution,settings}.rs @ ce0323f,
// Apache-2.0); see docs/licenses/README.md. Codex runs a full sub-agent with read-only tools and `approval_policy =
// never`; Pi runs one model loop with a single read-only `exec_command` tool under the read-only Seatbelt profile.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { permissionsInstructions, wrapPermissionsInstructions } from '../permissions.ts';
import { createSeatbeltCommandArgs, MACOS_PATH_TO_SEATBELT_EXECUTABLE, sandboxEnv, type SandboxPolicy } from '../seatbelt.ts';
import { GUARDIAN_OUTPUT_CONTRACT_PROMPT, parseGuardianAssessment } from './assessment.ts';
import { truncateText } from './context.ts';
import { isTransientProviderError, type ReviewOutcome } from './outcome.ts';
import { GUARDIAN_POLICY, GUARDIAN_POLICY_TEMPLATE, guardianPolicyInstructions } from './prompts.ts';

const MAX_REVIEWER_TOOL_ROUNDS = 12;
const MAX_COMMAND_OUTPUT_TOKENS = 2_500;
const MAX_COMMAND_MS = 30_000;
const READ_ONLY: SandboxPolicy = { mode: 'read-only', networkAccess: false };

export const EXEC_COMMAND_TOOL: Tool = {
  name: 'exec_command',
  description: 'Runs a shell command and returns its output. Commands run in a read-only sandbox with no network access; writes fail.',
  parameters: Type.Object({
    cmd: Type.String({ description: 'Shell command to execute.' }),
    workdir: Type.Optional(Type.String({ description: 'Working directory; relative paths resolve against the reviewed cwd.' })),
  }),
};

export interface ReviewerTurn {
  systemPrompt: string;
  userContent: string[];
  cwd: string;
  /** Epoch milliseconds shared by every attempt of one review. */
  deadline: number;
  signal?: AbortSignal;
  complete: (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;
  runCommand: (command: string, workdir: string, signal: AbortSignal) => Promise<string>;
}

class DeadlineExceeded extends Error {}

/** One review attempt: model turns with read-only tool calls until a final assessment. */
export async function runReviewerTurn(turn: ReviewerTurn): Promise<ReviewOutcome> {
  const remaining = turn.deadline - Date.now();
  const deadline = AbortSignal.timeout(Math.max(0, remaining));
  const signal = turn.signal ? AbortSignal.any([turn.signal, deadline]) : deadline;
  const stopped = (): ReviewOutcome | undefined => turn.signal?.aborted ? { type: 'error', error: { type: 'cancelled' } }
    : deadline.aborted || Date.now() >= turn.deadline ? { type: 'error', error: { type: 'timeout' } } : undefined;
  const messages: Message[] = [{ role: 'user', content: turn.userContent.map(text => ({ type: 'text', text })), timestamp: Date.now() }];
  try {
    for (let round = 0; round <= MAX_REVIEWER_TOOL_ROUNDS; round++) {
      const early = stopped();
      if (early) return early;
      const response = await raceAbort(turn.complete({ systemPrompt: turn.systemPrompt, messages, tools: [EXEC_COMMAND_TOOL] }, signal), signal);
      if (response.stopReason === 'aborted') return stopped() ?? { type: 'error', error: { type: 'cancelled' } };
      if (response.stopReason === 'error') {
        const message = response.errorMessage ?? 'reviewer request failed';
        return { type: 'error', error: { type: 'session', message, transient: isTransientProviderError(message) } };
      }
      messages.push(response);
      const calls = response.content.filter(part => part.type === 'toolCall');
      if (!calls.length) {
        const text = response.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
        if (!text.trim()) return { type: 'error', error: { type: 'session', message: 'guardian review completed without an assessment payload', transient: false } };
        try {
          return { type: 'completed', assessment: parseGuardianAssessment(text) };
        } catch (error) {
          return { type: 'error', error: { type: 'parse', message: (error as Error).message } };
        }
      }
      for (const call of calls) messages.push(await executeTool(call, turn, signal));
    }
    return { type: 'error', error: { type: 'session', message: `guardian review exceeded ${MAX_REVIEWER_TOOL_ROUNDS} tool rounds`, transient: false } };
  } catch (error) {
    const early = stopped();
    if (early) return early;
    const message = error instanceof Error ? error.message : String(error);
    return { type: 'error', error: { type: 'session', message, transient: isTransientProviderError(message) } };
  }
}

async function executeTool(call: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>, turn: ReviewerTurn, signal: AbortSignal): Promise<ToolResultMessage> {
  const result = (text: string, isError: boolean): ToolResultMessage =>
    ({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }], isError, timestamp: Date.now() });
  if (call.name !== EXEC_COMMAND_TOOL.name) return result(`Unknown tool \`${call.name}\`. Only \`exec_command\` is available.`, true);
  const { cmd, workdir } = call.arguments as { cmd?: unknown; workdir?: unknown };
  if (typeof cmd !== 'string' || !cmd.trim()) return result('`exec_command` requires a string `cmd`.', true);
  const directory = typeof workdir === 'string' && workdir ? resolve(turn.cwd, workdir) : turn.cwd;
  try {
    return result(await turn.runCommand(cmd, directory, signal), false);
  } catch (error) {
    if (signal.aborted) throw error;
    return result(`Command failed to start: ${(error as Error).message}`, true);
  }
}

function raceAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason ?? new DeadlineExceeded('aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    value.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Runs `bash -c` under the read-only Seatbelt profile with no network; output is capped like a transcript tool entry. */
export function runReadOnlyCommand(command: string, workdir: string, signal: AbortSignal): Promise<string> {
  if (process.platform !== 'darwin') return Promise.resolve('Read-only command checks are unavailable: the Seatbelt sandbox requires macOS.\nexit code: 1');
  const args = createSeatbeltCommandArgs(['/bin/bash', '-c', command], READ_ONLY, workdir);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(MACOS_PATH_TO_SEATBELT_EXECUTABLE, args, {
      cwd: workdir, env: { ...process.env, ...sandboxEnv(READ_ONLY) }, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.any([signal, AbortSignal.timeout(MAX_COMMAND_MS)]),
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.on('error', error => signal.aborted ? reject(error) : resolvePromise(`${truncateText(output, MAX_COMMAND_OUTPUT_TOKENS)}\n${error.message}\nexit code: 1`));
    child.on('close', (code, killSignal) => resolvePromise(`${truncateText(output, MAX_COMMAND_OUTPUT_TOKENS)}\nexit code: ${code ?? killSignal}`));
  });
}

export interface ReviewerPromptInput {
  /** Guardian's built-in policy unless the user overrides the tenant policy. */
  tenantPolicy?: string;
  extraPolicy: string;
  contextFiles: readonly { path: string; content: string }[];
  cwd: string;
  date: string;
  timezone: string;
  request: string[];
}

/** System prompt and leading user content mirroring the Codex reviewer session's instructions and context. */
export function buildReviewerPrompt(input: ReviewerPromptInput): { systemPrompt: string; userContent: string[] } {
  const policy = guardianPolicyInstructions({
    transcriptFormat: 'line', tenantPolicyConfig: input.tenantPolicy ?? GUARDIAN_POLICY, extraPolicy: input.extraPolicy,
    policyTemplate: GUARDIAN_POLICY_TEMPLATE, outputContract: GUARDIAN_OUTPUT_CONTRACT_PROMPT,
  });
  const permissions = wrapPermissionsInstructions(permissionsInstructions({
    sandboxMode: 'read-only', networkAccess: 'restricted', approvalPolicy: 'never', reviewer: 'user', approvedCommandPrefixes: [], writableRoots: [],
  }));
  const agentsFiles = input.contextFiles.map(file =>
    `# AGENTS.md instructions for ${file.path.replace(/\/[^/]*$/, '') || '/'}\n\n<INSTRUCTIONS>\n${file.content}\n</INSTRUCTIONS>`);
  const environment = `<environment_context>\n  <cwd>${input.cwd}</cwd>\n  <shell>bash</shell>\n  <current_date>${input.date}</current_date>\n  <timezone>${input.timezone}</timezone>\n</environment_context>`;
  return { systemPrompt: `${policy}\n${permissions}`, userContent: [...agentsFiles, environment, ...input.request] };
}
