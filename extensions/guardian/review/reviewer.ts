// The reviewer turn that stands in for Codex's Guardian review session (openai/codex codex-rs/core/src/guardian/
// {review_session,reviewer_config}.rs and codex-rs/ext/guardian-reviewer/src/{execution,settings}.rs @ ce0323f,
// Apache-2.0); see docs/licenses/README.md. Codex runs a full sub-agent with read-only tools and `approval_policy =
// never`; Pi runs one model loop with a single read-only `exec_command` tool under the read-only sandbox.
import { resolve } from 'node:path';
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { permissionsInstructions, wrapPermissionsInstructions } from '../permissions.ts';
import type { PlatformSandbox } from '../sandbox.ts';
import type { SandboxPolicy } from '../seatbelt.ts';
import { GUARDIAN_OUTPUT_CONTRACT_PROMPT, parseGuardianAssessment } from './assessment.ts';
import { truncateText } from './context.ts';
import { isTransientProviderError, type ReviewOutcome } from './outcome.ts';
import { runStarted } from './process.ts';
import { GUARDIAN_POLICY, GUARDIAN_POLICY_TEMPLATE, guardianPolicyInstructions } from './prompts.ts';

const MAX_REVIEWER_TOOL_ROUNDS = 12;
const MAX_COMMAND_OUTPUT_TOKENS = 2_500;
const MAX_COMMAND_MS = 30_000;
const MAX_CAPTURED_BYTES = 64 * 1024;
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
  // A referenced timer, unlike AbortSignal.timeout, keeps the process alive until the deadline fires, so a hung
  // reviewer still times out when nothing else is pending.
  const deadlineController = new AbortController();
  const deadline = deadlineController.signal;
  const timer = setTimeout(() => deadlineController.abort(new DeadlineExceeded('deadline')), Math.max(0, turn.deadline - Date.now()));
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
  } finally {
    clearTimeout(timer);
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

/** Runs `bash -c` in the read-only sandbox with no network; output is capped like a transcript tool entry. */
export async function runReadOnlyCommand(command: string, workdir: string, signal: AbortSignal, sandbox: PlatformSandbox | undefined): Promise<string> {
  if (!sandbox) return 'Read-only command checks are unavailable: this platform has no usable sandbox.\nexit code: 1';
  const run = await runStarted(() => sandbox.spawn(['/bin/bash', '-c', command], READ_ONLY, { cwd: workdir, env: process.env, stdin: 'pipe' }), {
    cwd: workdir, signal, timeoutMs: MAX_COMMAND_MS, maxBytes: MAX_CAPTURED_BYTES,
  });
  if (run.aborted) throw new Error('aborted');
  const output = truncateText(`${run.stdout}${run.stderr}`, MAX_COMMAND_OUTPUT_TOKENS);
  if (run.spawnError) return `${output}\n${run.spawnError}\nexit code: 1`;
  return `${output}\n${run.timedOut ? `timed out after ${MAX_COMMAND_MS / 1000} seconds` : `exit code: ${run.exitCode}`}`;
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
