// Pi's bash tool with Codex's shell approval flow, ported from openai/codex codex-rs/core/src/tools/{orchestrator,
// sandboxing}.rs, codex-rs/core/src/tools/handlers/shell_spec.rs and codex-rs/sandboxing/src/denial.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. Sandboxed commands are spawned directly as
// `sandbox-exec -- <shell> -c <command>` or `bwrap ... -- <shell> -c <command>`, so no unsandboxed shell runs first.
// Scripts are evaluated as `bash -lc <command>`, the form Codex parses into command segments.
import { type BashOperations, type BashToolDetails, createBashToolDefinition, getShellConfig, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ApprovalContext, ApprovalDecision, ApprovalRequest } from './approvals.ts';
import type { GuardianConfig } from './config.ts';
import { createExecApprovalRequirement, type SandboxPermissions } from './exec-policy.ts';
import { persistableAmendment } from './policies.ts';
import { DATABASE_FORBIDDEN_REASON, databaseDecision } from './database.ts';
import { RAILWAY_FORBIDDEN_REASON, RAILWAY_REVIEW_REASON, railwayDecision } from './railway.ts';
import type { Policy } from './rules.ts';
import { runStarted } from './review/process.ts';
import { isLikelySandboxDenied, type PlatformSandbox } from './sandbox.ts';
import type { SandboxPolicy } from './seatbelt.ts';
import type { Shell } from './shell.ts';

const RETRY_REASON = 'command failed; retry without sandbox?';
const NEVER_ESCALATE = 'approval policy is Never; reject command — you cannot request escalated permissions unless the approval policy is OnRequest';
const NEVER_WITHOUT_SANDBOX = 'approval policy is Never and no platform sandbox is available, so commands cannot run without approval; reject command';
const NETWORK_FAILURE = /could not resolve host|unable to resolve host|ENOTFOUND|EAI_AGAIN|network is unreachable|network unreachable/i;
const AUTH_FAILURE = /invalid (?:authentication )?token|token[^\n]{0,200}\binvalid|bad credentials|authentication failed|failed to log in|not logged in|HTTP (?:401|403)/i;
const NETWORK_CLIENTS = new Set(['gh', 'glab', 'curl', 'wget', 'git', 'ssh', 'scp', 'sftp']);

export interface ShellSettings {
  shellPath?: string;
  commandPrefix?: string;
}

export interface BashRuntime {
  config(): GuardianConfig;
  policy(): Policy;
  shellSettings(): ShellSettings;
  shell: Shell;
  /** Undefined when this platform has no usable sandbox, and every command is reviewed instead. */
  sandbox: PlatformSandbox | undefined;
  approvals: { request(request: ApprovalRequest, ctx: ApprovalContext, signal?: AbortSignal): Promise<ApprovalDecision> };
  /** Entry commits an authorized rule write; later cancellation does not roll it back. */
  persistAmendment(prefix: string[]): Promise<void>;
}

export function sandboxPolicyFor(config: GuardianConfig): SandboxPolicy {
  const { mode, networkAccess, writableRoots, excludeTmpdirEnvVar, excludeSlashTmp } = config.sandbox;
  return { mode: mode === 'read-only' ? 'read-only' : 'workspace-write', networkAccess, writableRoots, excludeTmpdirEnvVar, excludeSlashTmp };
}

/**
 * Spawns the shell directly inside the sandbox, so the sandbox owns the first process and no unsandboxed shell
 * reads its startup files first. Errors use Pi's own contract so its bash tool renders them.
 */
function sandboxedOperations(sandbox: PlatformSandbox, policy: SandboxPolicy, shellPath: string | undefined): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error('aborted');
      const shell = getShellConfig(shellPath);
      const argv = [shell.shell, ...shell.args, command];
      if (argv.some(argument => argument.includes('\0'))) throw new Error('This command cannot be run in the sandbox: it contains a NUL byte.');
      const result = await runStarted(budget => sandbox.spawn(argv, policy, { cwd, env: env ?? process.env, stdin: 'ignore', signal: budget }), {
        cwd, signal, timeoutMs: timeout !== undefined && timeout > 0 ? timeout * 1000 : Infinity, maxBytes: 0, onData,
      });
      if (result.aborted) throw new Error('aborted');
      if (result.timedOut) throw new Error(`timeout:${timeout}`);
      if (result.spawnError) throw new Error(result.spawnError);
      return { exitCode: result.exitCode };
    },
  };
}

/** Pi's own limits: a finite, positive number of seconds that fits a timer. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
function validTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid timeout: must be a finite number of seconds');
  if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  return timeout;
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
  return {
    ...base,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = runtime.config();
      const cwd = ctx?.cwd ?? defaultCwd;
      const settings = runtime.shellSettings();
      const shellOptions = {
        ...(settings.shellPath === undefined ? {} : { shellPath: settings.shellPath }),
        ...(settings.commandPrefix === undefined ? {} : { commandPrefix: settings.commandPrefix }),
      };
      // Strict tool schemas make optional fields nullable, so null means unset.
      const plain = { command: params.command, ...(params.timeout == null ? {} : { timeout: validTimeout(params.timeout) }) };
      const sandbox = sandboxPolicyFor(config);
      const run = (sandboxed: boolean): Promise<Result> => createBashToolDefinition(cwd, sandboxed && runtime.sandbox
        ? { ...shellOptions, operations: sandboxedOperations(runtime.sandbox, sandbox, settings.shellPath) }
        : shellOptions).execute(toolCallId, plain, signal, onUpdate, ctx);

      // Pi prepends the configured prefix, so rules and review judge the script that actually runs.
      const script = settings.commandPrefix ? `${settings.commandPrefix}\n${params.command}` : params.command;
      const command = ['bash', '-lc', script];
      const unrestricted = config.sandbox.mode === 'danger-full-access';
      // The Railway boundary binds before rules, settings and review, and even when Guardian is disabled.
      const railway = railwayDecision(runtime.shell, command);
      if (railway === 'forbidden') throw new Error(`\`${params.command}\` rejected: ${RAILWAY_FORBIDDEN_REASON}`);
      // A destructive database command whose target may be a Railway database is held to the same boundary.
      if (databaseDecision(runtime.shell, command) === 'forbidden') throw new Error(`\`${params.command}\` rejected: ${DATABASE_FORBIDDEN_REASON}`);
      if (!config.enabled) {
        if (railway === 'prompt') throw new Error(`\`${params.command}\` rejected: ${RAILWAY_REVIEW_REASON}, and Guardian is disabled`);
        return run(false);
      }

      const requested = (params.sandbox_permissions ?? 'use_default') as SandboxPermissions;
      if (requested !== 'use_default' && requested !== 'require_escalated') throw new Error(`unsupported sandbox_permissions: ${requested}`);
      if (requested === 'require_escalated' && config.approvalPolicy === 'never') throw new Error(NEVER_ESCALATE);
      // Without a platform sandbox every command would run unrestricted, so each one is reviewed as an escalation.
      const sandboxPermissions: SandboxPermissions = !unrestricted && !runtime.sandbox ? 'require_escalated' : requested;
      const requirement = createExecApprovalRequirement(runtime.shell, runtime.policy(), {
        command, approvalPolicy: config.approvalPolicy, fileSystem: unrestricted ? 'unrestricted' : 'restricted', sandboxPermissions,
        ...(params.prefix_rule ? { prefixRule: params.prefix_rule } : {}),
      });
      if (requirement.type === 'forbidden') throw new Error(requirement.reason);
      // A Railway command that can reach data is reviewed even when rules or settings would skip it.
      const effective = requirement.type === 'skip' && railway === 'prompt'
        ? { type: 'needs_approval' as const, reason: RAILWAY_REVIEW_REASON, proposedExecpolicyAmendment: undefined }
        : requirement;

      const approvalContext = ctx as unknown as ApprovalContext;
      const approve = async (permissions: SandboxPermissions, reason: string | undefined, proposed: string[] | undefined) => {
        // Only offer "don't ask again" for a prefix that can actually be saved.
        const amendment = proposed && persistableAmendment(runtime.shell, proposed);
        const decision = await runtime.approvals.request({
          action: { tool: 'bash', command, cwd, sandbox_permissions: permissions, ...(params.justification ? { justification: params.justification } : {}), environment_id: 'local' },
          // The whole command, so nothing you approve is hidden past a cut-off.
          summary: params.command,
          ...(params.justification ? { justification: params.justification } : {}),
          ...(reason === undefined ? {} : { reason }),
          ...(amendment ? { amendment } : {}),
        }, approvalContext, signal);
        if (decision.type !== 'approved') throw new Error(decision.message);
        if (signal?.aborted) throw new Error('Operation aborted');
        if (!decision.persist) return;
        // The command is approved either way; a rule that could not be saved only means you are asked again.
        try {
          await runtime.persistAmendment(decision.persist);
        } catch (error) {
          if (approvalContext.hasUI) approvalContext.ui.notify(`Could not save the approved rule: ${(error as Error).message}`, 'warning');
        }
      };

      let approved = false;
      if (effective.type === 'needs_approval') {
        await approve(sandboxPermissions, effective.reason, effective.proposedExecpolicyAmendment);
        approved = true;
      }
      const bypass = unrestricted || (effective.type === 'skip' && effective.bypassSandbox) || (sandboxPermissions === 'require_escalated' && approved);
      // Under `never`, an unmatched command is allowed to run in the sandbox; with no sandbox it cannot run at all.
      if (!bypass && !runtime.sandbox) throw new Error(NEVER_WITHOUT_SANDBOX);
      const result = await run(!bypass);
      const exitCode = (result as { structuredContent?: { exit_code?: number } }).structuredContent?.exit_code ?? 0;
      const output = result.content.map(part => part.type === 'text' ? part.text : '').join('');
      const sandboxDenied = isLikelySandboxDenied(exitCode, output, runtime.sandbox?.kind);
      let hint: string | undefined;
      if (!bypass && exitCode !== 0) {
        const networkClient = runtime.shell.expandLiteralCommands(command).some(argv => NETWORK_CLIENTS.has(argv[0]?.split('/').pop() ?? ''));
        if (!config.sandbox.networkAccess && (NETWORK_FAILURE.test(output) || (networkClient && AUTH_FAILURE.test(output)))) {
          hint = 'Sandbox hint: network access is disabled. The original error may also have another cause.';
        } else if (sandboxDenied) {
          hint = 'Sandbox hint: this command may have hit a sandbox access restriction.';
        }
      }
      let diagnostic = result;
      if (hint) {
        hint += config.approvalPolicy === 'never' ? ' Escalation is disabled by the current approval policy.'
          : ' If the task requires access outside the sandbox, retry with sandbox_permissions: "require_escalated" and a justification.';
        const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
        diagnostic = {
          ...result, content: [...result.content, { type: 'text', text: hint }],
          ...(structured ? { structuredContent: { ...structured, output: `${structured.output ?? output}\n\n${hint}` } } : {}),
        };
      }
      if (bypass || config.approvalPolicy !== 'unless-trusted' || !sandboxDenied) return diagnostic;
      if (!approved) await approve('require_escalated', RETRY_REASON, effective.type === 'needs_approval' ? effective.proposedExecpolicyAmendment : undefined);
      return run(false);
    },
  };
}
