// Guardian: Codex's approval stack for Pi. Our inspiration from this code comes from there: openai/codex
// (https://github.com/openai/codex, Apache-2.0) at ce0323f2f2d3b25e82806cd555237da3db4e1897. See docs/licenses/README.md.
import { existsSync, statSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendAllowPrefixRule } from './amend.ts';
import { type ApprovalContext, Approvals, manualApprovalMessage } from './approvals.ts';
import { createGuardianBashTool, sandboxPolicyFor } from './bash.ts';
import { FAIL_CLOSED_CONFIG, type GuardianConfig, guardianStatusText, loadGuardianConfig } from './config.ts';
import { createGuardianFileTools } from './files.ts';
import { permissionsInstructions } from './permissions.ts';
import { defaultRulesPath, extraPolicy, guardianConfigPath, type LoadedPolicies, loadPolicies, persistableAmendment, userRulesDir } from './policies.ts';
import { collectReviewEvidence, composeReviewRequest, MANUAL_APPROVAL_MESSAGE_TYPE, prepareTranscript } from './review/context.ts';
import { CLAUDE_CLI_PROVIDER } from './config.ts';
import { runClaudeCliReview } from './review/claude-cli.ts';
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
  let lastValid: GuardianConfig | undefined;
  let reportedError: string | undefined;

  /**
   * Reads config.json when it changes. An invalid file keeps the last valid settings, so a typo never relaxes
   * permissions; with no valid settings yet, every reviewable action is sent to review or to you.
   */
  const config = (): GuardianConfig => {
    const path = guardianConfigPath();
    let stamp = 'missing';
    try { const info = statSync(path); stamp = `${info.ino}:${info.mtimeMs}:${info.size}`; } catch { /* missing means defaults */ }
    if (cached?.stamp !== stamp) {
      try {
        lastValid = loadGuardianConfig(path);
        cached = { stamp, config: lastValid };
      } catch (error) {
        const message = `Guardian config error: ${(error as Error).message}`;
        cached = lastValid
          ? { stamp, config: lastValid, error: `${message}; keeping the last valid settings` }
          : { stamp, config: FAIL_CLOSED_CONFIG, error: `${message}; every reviewable action needs approval until it is fixed` };
      }
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
    const claudeCli = settings.reviewer.provider === CLAUDE_CLI_PROVIDER;
    const reviewer = claudeCli ? undefined : resolveReviewer(ctx.modelRegistry, settings.reviewer, `guardian-${sessionId}`);
    if (reviewer && !reviewer.ok) return { type: 'error', error: { type: 'prompt_build', message: reviewer.message } };
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
      return await runWithRetry({ maxAttempts: MAX_REVIEW_ATTEMPTS, deadline: Date.now() + REVIEW_TIMEOUT_MS }, signal, deadline => reviewer
        ? runReviewerTurn({ ...prompt, cwd: ctx.cwd, deadline, ...(signal ? { signal } : {}), complete: reviewer.complete, runCommand: runReadOnlyCommand })
        : runClaudeCliReview({ ...prompt, cwd: ctx.cwd, model: settings.reviewer.model, reasoning: settings.reviewer.reasoning, deadline, ...(signal ? { signal } : {}) }));
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
    }
  };
  const approvals = new Approvals({ config, review, turnId: () => String(turn) });

  const shellSettings = () => {
    const settings = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
    return {
      ...(settings.shellPath === undefined ? {} : { shellPath: settings.shellPath }),
      ...(settings.shellCommandPrefix === undefined ? {} : { commandPrefix: settings.shellCommandPrefix }),
    };
  };
  pi.registerTool(createGuardianBashTool({
    config, policy: () => policies.policy, shellSettings, shell, sandboxAvailable, approvals,
    persistAmendment: async prefix => {
      const persistable = persistableAmendment(shell, prefix);
      if (!persistable) return;
      await appendAllowPrefixRule(defaultRulesPath(), persistable);
      await reloadPolicies();
    },
  }, process.cwd()));
  for (const tool of createGuardianFileTools({ config, sandboxAvailable, approvals }, process.cwd())) pi.registerTool(tool);

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
      // Without a platform sandbox nothing is confined, and every command needs approval instead.
      sandboxMode: sandboxed ? settings.sandbox.mode : 'danger-full-access',
      approvalPolicy: sandboxed ? settings.approvalPolicy : 'unless-trusted',
      networkAccess: settings.sandbox.networkAccess ? 'enabled' : 'restricted',
      reviewer: settings.approvalsReviewer,
      approvedCommandPrefixes: policies.policy.allowedPrefixes(),
      writableRoots: sandboxed && settings.sandbox.mode === 'workspace-write' ? workspaceWriteRoots(sandboxPolicyFor(settings), ctx.cwd, process.env).map(root => root.root) : [],
    });
  });

  pi.registerCommand('guardian', {
    description: 'Show Guardian approval settings, approve the last denied action, or reload rules',
    getArgumentCompletions: prefix => ['status', 'approve', 'reload'].filter(name => name.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      const action = args.trim() || 'status';
      if (action === 'approve') {
        const denied = approvals.takeDenied();
        if (!denied) return ctx.ui.notify('No denied action to approve.', 'info');
        pi.sendMessage({ customType: MANUAL_APPROVAL_MESSAGE_TYPE, content: manualApprovalMessage(denied.actionJson), display: true }, { triggerTurn: true });
        return ctx.ui.notify(`Approved: ${denied.summary}`, 'info');
      }
      if (action === 'reload') {
        await reloadPolicies();
        cached = undefined;
        reportedError = undefined;
        config();
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
