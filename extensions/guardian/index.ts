// Guardian: Codex's approval stack for Pi. Our inspiration from this code comes from there: openai/codex
// (https://github.com/openai/codex, Apache-2.0) at ce0323f2f2d3b25e82806cd555237da3db4e1897. See docs/licenses/README.md.
import { existsSync, statSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendAllowPrefixRule } from './amend.ts';
import { type ApprovalContext, Approvals, manualApprovalMessage } from './approvals.ts';
import { createGuardianBashTool, sandboxPolicyFor } from './bash.ts';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig, guardianStatusText, loadGuardianConfig } from './config.ts';
import { assessFileChange, fileChangeAction, resolveToolPath } from './files.ts';
import { permissionsInstructions } from './permissions.ts';
import { defaultRulesPath, extraPolicy, guardianConfigPath, type LoadedPolicies, loadPolicies, userRulesDir } from './policies.ts';
import { collectReviewEvidence, composeReviewRequest, MANUAL_APPROVAL_MESSAGE_TYPE, prepareTranscript } from './review/context.ts';
import { resolveReviewer } from './review/model.ts';
import { MAX_REVIEW_ATTEMPTS, REVIEW_TIMEOUT_MS, type ReviewOutcome, runWithRetry } from './review/outcome.ts';
import { buildReviewerPrompt, runReadOnlyCommand, runReviewerTurn } from './review/reviewer.ts';
import { MACOS_PATH_TO_SEATBELT_EXECUTABLE, workspaceWriteRoots } from './seatbelt.ts';
import { loadShell } from './shell.ts';

const REVIEW_STATUS_KEY = 'guardian-review';

export default async function guardian(pi: ExtensionAPI): Promise<void> {
  const shell = await loadShell();
  const sandboxAvailable = process.platform === 'darwin' && existsSync(MACOS_PATH_TO_SEATBELT_EXECUTABLE);
  let policies: LoadedPolicies = await loadPolicies([userRulesDir()]);
  let contextFiles: { path: string; content: string }[] = [];
  let turn = 0;
  let cached: { stamp: string; config: GuardianConfig; error?: string } | undefined;
  let reportedError: string | undefined;

  /** Reads config.json when it changes; an invalid file keeps Guardian on with the defaults. */
  const config = (): GuardianConfig => {
    const path = guardianConfigPath();
    let stamp = 'missing';
    try { const info = statSync(path); stamp = `${info.ino}:${info.mtimeMs}:${info.size}`; } catch { /* missing means defaults */ }
    if (cached?.stamp !== stamp) {
      try { cached = { stamp, config: loadGuardianConfig(path) }; }
      catch (error) { cached = { stamp, config: DEFAULT_GUARDIAN_CONFIG, error: `Guardian config error, using defaults: ${(error as Error).message}` }; }
    }
    return cached.config;
  };
  const reportProblems = (ctx: ExtensionContext) => {
    config();
    const problem = cached?.error ?? policies.warning;
    if (problem && problem !== reportedError && ctx.hasUI) ctx.ui.notify(problem, 'warning');
    reportedError = problem;
  };
  const reloadPolicies = async () => { policies = await loadPolicies([userRulesDir()]); };

  const review = async (input: { actionJson: string; reason?: string }, approvalContext: ApprovalContext, signal?: AbortSignal): Promise<ReviewOutcome> => {
    const ctx = approvalContext as unknown as ExtensionContext;
    const settings = config();
    const sessionId = ctx.sessionManager.getSessionId();
    const reviewer = resolveReviewer(ctx.modelRegistry, settings.reviewer, `guardian-${sessionId}`);
    if (!reviewer.ok) return { type: 'error', error: { type: 'prompt_build', message: reviewer.message } };
    const evidence = collectReviewEvidence(ctx.sessionManager.getBranch());
    const request = composeReviewRequest({
      transcript: prepareTranscript(evidence.transcript, 0, 'line'), sessionId, trustedUserAnswers: evidence.trustedUserAnswers, environmentId: 'local',
      plannedAction: { json: input.actionJson, ...(input.reason === undefined ? {} : { reason: input.reason }) },
    });
    const now = new Date();
    const prompt = buildReviewerPrompt({
      ...(settings.autoReview.policy === undefined ? {} : { tenantPolicy: settings.autoReview.policy }),
      extraPolicy: await extraPolicy(settings.autoReview.extraPolicy), contextFiles, cwd: ctx.cwd,
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, request,
    });
    if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, 'Reviewing approval request…');
    try {
      return await runWithRetry({ maxAttempts: MAX_REVIEW_ATTEMPTS, deadline: Date.now() + REVIEW_TIMEOUT_MS }, signal, deadline => runReviewerTurn({
        ...prompt, cwd: ctx.cwd, deadline, ...(signal ? { signal } : {}), complete: reviewer.complete, runCommand: runReadOnlyCommand,
      }));
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
    }
  };
  const approvals = new Approvals({ config, review, turnId: () => String(turn) });

  pi.registerTool(createGuardianBashTool({
    config, policy: () => policies.policy, shell, sandboxAvailable, approvals,
    persistAmendment: async prefix => { await appendAllowPrefixRule(defaultRulesPath(), prefix); await reloadPolicies(); },
  }, process.cwd()));

  pi.on('session_start', async (_event, ctx) => {
    await reloadPolicies();
    reportedError = undefined;
    reportProblems(ctx);
    if (ctx.hasUI && pi.getCommands().some(command => command.name.split(':')[0] === 'auto-permissions')) {
      ctx.ui.notify('Auto Permissions is also loaded, so commands are reviewed twice. Uninstall it to use Guardian alone.', 'warning');
    }
  });
  pi.on('agent_start', () => { turn++; });
  pi.on('agent_end', () => { approvals.clearTurn(String(turn)); });

  pi.on('before_agent_start', (event, ctx) => {
    contextFiles = event.systemPromptOptions.contextFiles;
    reportProblems(ctx);
    const settings = config();
    if (!settings.enabled) return;
    const sandboxed = settings.sandbox.mode !== 'danger-full-access' && sandboxAvailable;
    event.systemPromptOptions.sections.permissions_instructions = permissionsInstructions({
      sandboxMode: sandboxed ? settings.sandbox.mode : 'danger-full-access',
      networkAccess: settings.sandbox.networkAccess ? 'enabled' : 'restricted',
      approvalPolicy: settings.approvalPolicy,
      reviewer: settings.approvalsReviewer,
      approvedCommandPrefixes: policies.policy.allowedPrefixes(),
      writableRoots: sandboxed && settings.sandbox.mode === 'workspace-write' ? workspaceWriteRoots(sandboxPolicyFor(settings), ctx.cwd, process.env).map(root => root.root) : [],
    });
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'write' && event.toolName !== 'edit') return;
    const input = event.input as { path?: unknown; content?: unknown; edits?: unknown };
    if (typeof input.path !== 'string') return;
    const path = resolveToolPath(input.path, ctx.cwd);
    const safety = assessFileChange(path, { config: config(), cwd: ctx.cwd, sandboxAvailable });
    if (safety === 'auto_approve') return;
    if (typeof safety === 'object') return { block: true, reason: safety.reason };
    const decision = await approvals.request({
      action: fileChangeAction(event.toolName, { ...input, path: input.path }, path, ctx.cwd), summary: `${event.toolName} ${path}`,
    }, ctx, ctx.signal);
    return decision.type === 'approved' ? undefined : { block: true, reason: decision.message };
  });

  pi.registerCommand('guardian', {
    description: 'Show Guardian approval settings, approve the last denied action, or reload rules',
    getArgumentCompletions: prefix => ['status', 'approve', 'reload'].filter(name => name.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      const action = args.trim() || 'status';
      if (action === 'approve') {
        const denied = approvals.lastDenied();
        if (!denied) return ctx.ui.notify('No denied action to approve.', 'info');
        pi.sendMessage({ customType: MANUAL_APPROVAL_MESSAGE_TYPE, content: manualApprovalMessage(denied.actionJson), display: true }, { triggerTurn: true });
        return ctx.ui.notify(`Approved: ${denied.summary}`, 'info');
      }
      if (action === 'reload') {
        await reloadPolicies();
        cached = undefined;
        reportedError = undefined;
        reportProblems(ctx);
      } else if (action !== 'status') {
        return ctx.ui.notify('Usage: /guardian [status|approve|reload]', 'warning');
      }
      const settings = config();
      ctx.ui.notify([
        guardianStatusText(settings, sandboxAvailable),
        `Config: ${guardianConfigPath()}${cached?.error ? ` (${cached.error})` : ''}`,
        `Approvals: ${settings.approvalPolicy}, reviewed by ${settings.approvalsReviewer === 'user' ? 'you' : `${settings.reviewer.provider}/${settings.reviewer.model} (${settings.reviewer.reasoning})`}`,
        `Sandbox: ${sandboxAvailable ? settings.sandbox.mode : 'unavailable on this platform'}, network ${settings.sandbox.networkAccess ? 'on' : 'off'}`,
        `Rules: ${userRulesDir()}${policies.warning ? ` (${policies.warning})` : ''}`,
      ].join('\n'), 'info');
    },
  });
}
