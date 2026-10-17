// Pi's bash tool with Codex's shell approval flow, ported from openai/codex codex-rs/core/src/tools/{orchestrator,
// sandboxing}.rs, codex-rs/core/src/tools/handlers/shell_spec.rs and codex-rs/sandboxing/src/denial.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. Sandboxed commands are spawned directly as
// `sandbox-exec -- <shell> -c <command>` so no unsandboxed shell runs first. Scripts are evaluated as
// `bash -lc <command>`, the form Codex parses into command segments.
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { type BashOperations, type BashToolDetails, createBashToolDefinition, getShellConfig, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ApprovalContext, ApprovalDecision, ApprovalRequest } from './approvals.ts';
import type { GuardianConfig } from './config.ts';
import { createExecApprovalRequirement, type SandboxPermissions } from './exec-policy.ts';
import { RAILWAY_FORBIDDEN_REASON, RAILWAY_REVIEW_REASON, railwayDecision } from './railway.ts';
import type { Policy } from './rules.ts';
import { createSeatbeltCommandArgs, MACOS_PATH_TO_SEATBELT_EXECUTABLE, sandboxEnv, type SandboxPolicy } from './seatbelt.ts';
import type { Shell } from './shell.ts';

const SANDBOX_DENIED_KEYWORDS = ['operation not permitted', 'permission denied', 'read-only file system', 'seccomp', 'sandbox', 'landlock', 'failed to write file'];
const RETRY_REASON = 'command failed; retry without sandbox?';
const NEVER_ESCALATE = 'approval policy is Never; reject command — you cannot request escalated permissions unless the approval policy is OnRequest';
const MAX_SUMMARY_CHARS = 300;

export interface ShellSettings {
  shellPath?: string;
  commandPrefix?: string;
}

export interface BashRuntime {
  config(): GuardianConfig;
  policy(): Policy;
  shellSettings(): ShellSettings;
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

/**
 * Spawns `sandbox-exec -- <shell> -c <command>` directly, so the sandbox owns the first process and no
 * unsandboxed shell reads its startup files first. Errors use Pi's own contract so its bash tool renders them.
 */
function sandboxedOperations(policy: SandboxPolicy, shellPath: string | undefined): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error('aborted');
      const shell = (() => { try { return getShellConfig(shellPath); } catch { return { shell: '/bin/bash', args: ['-c'] }; } })();
      const environment = { ...(env ?? process.env), ...sandboxEnv(policy) };
      const args = createSeatbeltCommandArgs([shell.shell, ...shell.args, command], policy, cwd, environment);
      if (args.some(argument => argument.includes('\0'))) throw new Error('This command cannot be run in the sandbox: it contains a NUL byte.');
      return new Promise((settled, reject) => {
        const child = spawn(MACOS_PATH_TO_SEATBELT_EXECUTABLE, args, { cwd, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let timedOut = false;
        const killGroup = () => {
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        const onAbort = () => killGroup();
        const timer = timeout !== undefined && timeout > 0 ? setTimeout(() => { timedOut = true; killGroup(); }, timeout * 1000) : undefined;
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const finish = (complete: () => void) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          complete();
        };
        child.on('error', error => finish(() => reject(error)));
        // Resolve when the command itself exits. Waiting for the streams to close hangs on a backgrounded
        // process that inherited them.
        child.on('exit', (code, killSignal) => finish(() => {
          if (signal?.aborted) return reject(new Error('aborted'));
          if (timedOut) return reject(new Error(`timeout:${timeout}`));
          settled({ exitCode: code ?? (killSignal ? 128 + (osConstants.signals[killSignal] ?? 0) : null) });
        }));
      });
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
      const run = (sandboxed: boolean): Promise<Result> => createBashToolDefinition(cwd, sandboxed
        ? { ...shellOptions, operations: sandboxedOperations(sandbox, settings.shellPath) }
        : shellOptions).execute(toolCallId, plain, signal, onUpdate, ctx);

      // Pi prepends the configured prefix, so rules and review judge the script that actually runs.
      const script = settings.commandPrefix ? `${settings.commandPrefix}\n${params.command}` : params.command;
      const command = ['bash', '-lc', script];
      const unrestricted = config.sandbox.mode === 'danger-full-access';
      // The Railway boundary binds before rules, settings and review, and even when Guardian is disabled.
      const railway = railwayDecision(runtime.shell, command);
      if (railway === 'forbidden') throw new Error(`\`${params.command}\` rejected: ${RAILWAY_FORBIDDEN_REASON}`);
      if (!config.enabled) {
        if (railway === 'prompt') throw new Error(`\`${params.command}\` rejected: ${RAILWAY_REVIEW_REASON}, and Guardian is disabled`);
        return run(false);
      }

      const requested = (params.sandbox_permissions ?? 'use_default') as SandboxPermissions;
      if (requested !== 'use_default' && requested !== 'require_escalated') throw new Error(`unsupported sandbox_permissions: ${requested}`);
      if (requested === 'require_escalated' && config.approvalPolicy === 'never') throw new Error(NEVER_ESCALATE);
      // Without a platform sandbox every command would run unrestricted, so each one is reviewed as an escalation.
      const sandboxPermissions: SandboxPermissions = !unrestricted && !runtime.sandboxAvailable ? 'require_escalated' : requested;
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
      if (effective.type === 'needs_approval') {
        await approve(sandboxPermissions, effective.reason, effective.proposedExecpolicyAmendment);
        approved = true;
      }
      const bypass = unrestricted || (effective.type === 'skip' && effective.bypassSandbox) || (sandboxPermissions === 'require_escalated' && approved);
      const result = await run(!bypass);
      // On-request returns sandbox denials to the agent; unless-trusted asks to retry outside the sandbox.
      const exitCode = (result as { structuredContent?: { exit_code?: number } }).structuredContent?.exit_code ?? 0;
      const output = result.content.map(part => part.type === 'text' ? part.text : '').join('');
      if (bypass || config.approvalPolicy !== 'unless-trusted' || !isLikelySandboxDenied(exitCode, output)) return result;
      await approve('require_escalated', RETRY_REASON, effective.type === 'needs_approval' ? effective.proposedExecpolicyAmendment : undefined);
      return run(false);
    },
  };
}
