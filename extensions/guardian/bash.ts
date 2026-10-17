// Pi's bash tool with Codex's shell approval flow, ported from openai/codex codex-rs/core/src/tools/{orchestrator,
// sandboxing}.rs, codex-rs/core/src/tools/handlers/shell_spec.rs and codex-rs/sandboxing/src/denial.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. Commands run in Pi's own shell, wrapped in Seatbelt unless approved
// to escape it. Scripts are evaluated as `bash -lc <command>`, the form Codex parses into command segments.
import { type BashToolDetails, createBashToolDefinition, getShellConfig, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ApprovalContext, ApprovalDecision, ApprovalRequest } from './approvals.ts';
import type { GuardianConfig } from './config.ts';
import { createExecApprovalRequirement, type SandboxPermissions } from './exec-policy.ts';
import type { Policy } from './rules.ts';
import { createSeatbeltCommandArgs, MACOS_PATH_TO_SEATBELT_EXECUTABLE, sandboxEnv, type SandboxPolicy } from './seatbelt.ts';
import type { Shell } from './shell.ts';
import { shlexTryJoin } from './shlex.ts';

const SANDBOX_DENIED_KEYWORDS = ['operation not permitted', 'permission denied', 'read-only file system', 'seccomp', 'sandbox', 'landlock', 'failed to write file'];
const RETRY_REASON = 'command failed; retry without sandbox?';
const NEVER_ESCALATE = 'approval policy is Never; reject command — you cannot request escalated permissions unless the approval policy is OnRequest';
const MAX_SUMMARY_CHARS = 300;

export interface BashRuntime {
  config(): GuardianConfig;
  policy(): Policy;
  shell: Shell;
  sandboxAvailable: boolean;
  approvals: { request(request: ApprovalRequest, ctx: ApprovalContext, signal?: AbortSignal): Promise<ApprovalDecision> };
  persistAmendment(prefix: string[]): Promise<void>;
}

/** Codex's executor-managed sandbox denial heuristic: a failure whose output names a sandbox restriction. */
export function isLikelySandboxDenied(exitCode: number, output: string): boolean {
  if (exitCode === 0) return false;
  const lower = output.toLowerCase();
  return SANDBOX_DENIED_KEYWORDS.some(keyword => lower.includes(keyword));
}

export function sandboxPolicyFor(config: GuardianConfig): SandboxPolicy {
  const { mode, networkAccess, writableRoots, excludeTmpdirEnvVar, excludeSlashTmp } = config.sandbox;
  return { mode: mode === 'read-only' ? 'read-only' : 'workspace-write', networkAccess, writableRoots, excludeTmpdirEnvVar, excludeSlashTmp };
}

const parameters = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
  sandbox_permissions: Type.Optional(Type.String({
    enum: ['use_default', 'require_escalated'],
    description: 'Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.',
  })),
  justification: Type.Optional(Type.String({ description: 'User-facing approval question for `require_escalated`; omit otherwise.' })),
  prefix_rule: Type.Optional(Type.Array(Type.String(), {
    description: 'Reusable approval prefix for `command`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
  })),
});

type Result = Awaited<ReturnType<ToolDefinition<typeof parameters, BashToolDetails | undefined>['execute']>>;

export function createGuardianBashTool(runtime: BashRuntime, defaultCwd: string): ToolDefinition<typeof parameters, BashToolDetails | undefined> {
  const base = createBashToolDefinition(defaultCwd);
  const shellPath = () => { try { return getShellConfig().shell; } catch { return 'bash'; } };
  return {
    ...base,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = runtime.config();
      const cwd = ctx?.cwd ?? defaultCwd;
      const plain = { command: params.command, ...(params.timeout === undefined ? {} : { timeout: params.timeout }) };
      const sandbox = sandboxPolicyFor(config);
      const run = (sandboxed: boolean): Promise<Result> => createBashToolDefinition(cwd, sandboxed ? {
        spawnHook: spawn => ({
          ...spawn,
          command: `exec ${shlexTryJoin([MACOS_PATH_TO_SEATBELT_EXECUTABLE, ...createSeatbeltCommandArgs([shellPath(), '-c', spawn.command], sandbox, spawn.cwd, spawn.env)])}`,
          env: { ...spawn.env, ...sandboxEnv(sandbox) },
        }),
      } : {}).execute(toolCallId, plain, signal, onUpdate, ctx);
      if (!config.enabled) return run(false);

      const requested = (params.sandbox_permissions ?? 'use_default') as SandboxPermissions;
      if (requested !== 'use_default' && requested !== 'require_escalated') throw new Error(`unsupported sandbox_permissions: ${requested}`);
      if (requested === 'require_escalated' && config.approvalPolicy === 'never') throw new Error(NEVER_ESCALATE);
      const unrestricted = config.sandbox.mode === 'danger-full-access';
      // Without a platform sandbox every command would run unrestricted, so each one is reviewed as an escalation.
      const sandboxPermissions: SandboxPermissions = !unrestricted && !runtime.sandboxAvailable ? 'require_escalated' : requested;
      const command = ['bash', '-lc', params.command];
      const requirement = createExecApprovalRequirement(runtime.shell, runtime.policy(), {
        command, approvalPolicy: config.approvalPolicy, fileSystem: unrestricted ? 'unrestricted' : 'restricted', sandboxPermissions,
        ...(params.prefix_rule ? { prefixRule: params.prefix_rule } : {}),
      });
      if (requirement.type === 'forbidden') throw new Error(requirement.reason);

      const approvalContext = ctx as unknown as ApprovalContext;
      const approve = async (permissions: SandboxPermissions, reason: string | undefined, amendment: string[] | undefined) => {
        const decision = await runtime.approvals.request({
          action: { tool: 'bash', command, cwd, sandbox_permissions: permissions, ...(params.justification ? { justification: params.justification } : {}), environment_id: 'local' },
          summary: params.command.length > MAX_SUMMARY_CHARS ? `${params.command.slice(0, MAX_SUMMARY_CHARS)}…` : params.command,
          ...(params.justification ? { justification: params.justification } : {}),
          ...(reason === undefined ? {} : { reason }),
          ...(amendment ? { amendment } : {}),
        }, approvalContext, signal);
        if (decision.type !== 'approved') throw new Error(decision.message);
        if (decision.persist) await runtime.persistAmendment(decision.persist);
      };

      let approved = false;
      if (requirement.type === 'needs_approval') {
        await approve(sandboxPermissions, requirement.reason, requirement.proposedExecpolicyAmendment);
        approved = true;
      }
      const bypass = unrestricted || (requirement.type === 'skip' && requirement.bypassSandbox) || (sandboxPermissions === 'require_escalated' && approved);
      const result = await run(!bypass);
      // On-request returns sandbox denials to the agent; unless-trusted asks to retry outside the sandbox.
      const exitCode = (result as { structuredContent?: { exit_code?: number } }).structuredContent?.exit_code ?? 0;
      const output = result.content.map(part => part.type === 'text' ? part.text : '').join('');
      if (bypass || config.approvalPolicy !== 'unless-trusted' || !isLikelySandboxDenied(exitCode, output)) return result;
      await approve('require_escalated', RETRY_REASON, requirement.proposedExecpolicyAmendment);
      return run(false);
    },
  };
}
