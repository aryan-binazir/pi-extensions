// Guardian: Codex's approval stack for Pi. Our inspiration from this code comes from there. The source is openai/codex
// (https://github.com/openai/codex, Apache-2.0) at ce0323f2f2d3b25e82806cd555237da3db4e1897. See docs/licenses/README.md.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { appendAllowPrefixRule } from './amend.ts';
import { APPROVAL_AUDIT_ENTRY_TYPE, type ApprovalAuditEntry, type ApprovalContext, Approvals, manualApprovalMessage } from './approvals.ts';
import { createGuardianBashTool, sandboxPolicyFor } from './bash.ts';
import { CLAUDE_CLI_PROVIDER, FAIL_CLOSED_CONFIG, GUARDIAN_ENABLED_EVENT, type GuardianConfig, guardianStatusText, loadGuardianConfig } from './config.ts';
import { createGuardianFileTools } from './files.ts';
import { createConnectorGate } from './connectors.ts';
import { permissionsInstructions } from './permissions.ts';
import { defaultRulesPath, extraPolicy, guardianConfigPath, type LoadedPolicies, loadPolicies, persistableAmendment, retainPolicies, userRulesDir } from './policies.ts';
import { collectReviewEvidence, composeReviewRequest, MANUAL_APPROVAL_MESSAGE_TYPE, prepareTranscript, truncateText } from './review/context.ts';
import { runClaudeCliReview } from './review/claude-cli.ts';
import { resolveReviewer } from './review/model.ts';
import { MAX_REVIEW_ATTEMPTS, REVIEW_TIMEOUT_MS, type ReviewOutcome, runWithRetry } from './review/outcome.ts';
import { buildReviewerPrompt, runReadOnlyCommand, runReviewerTurn } from './review/reviewer.ts';
import { detectPlatformSandbox } from './sandbox.ts';
import { workspaceWriteRoots } from './seatbelt.ts';
import { loadShell } from './shell.ts';

const REVIEW_STATUS_KEY = 'guardian-review';

/**
 * Tools that refuse every call. A Guardian that cannot start must still replace Pi's `bash`, `write` and `edit`;
 * otherwise Pi would run them unguarded.
 */
export function registerFailClosed(pi: Pick<ExtensionAPI, 'registerTool' | 'on' | 'getAllTools'>, error: unknown, cwd = process.cwd()): void {
  const message = `Guardian could not start, so commands, file changes and review-required connector calls are blocked: ${error instanceof Error ? error.message : String(error)}. Fix it and run /reload.`;
  const refuse = async (): Promise<never> => { throw new Error(message); };
  for (const tool of [createBashToolDefinition(cwd), createWriteToolDefinition(cwd), createEditToolDefinition(cwd)]) {
    pi.registerTool({ ...tool, execute: refuse } as unknown as ToolDefinition);
  }
  pi.on('tool_call', createConnectorGate({ config: () => FAIL_CLOSED_CONFIG, tools: () => pi.getAllTools(),
    approvals: { clearDenied: () => {}, request: async () => ({ type: 'rejected', message }) } }));
  pi.on('session_start', (_event, ctx) => { if (ctx.hasUI) ctx.ui.notify(message, 'error'); });
}

/**
 * The sandbox and approval policy the agent is told about, as they actually behave. Without a platform sandbox,
 * on-request asks about every command, like unless-trusted, and never runs only what your rules allow.
 */
export function instructedPermissions(settings: GuardianConfig, sandboxAvailable: boolean): { sandboxMode: GuardianConfig['sandbox']['mode']; approvalPolicy: GuardianConfig['approvalPolicy'] } {
  if (settings.sandbox.mode === 'host') return { sandboxMode: 'host', approvalPolicy: settings.approvalPolicy };
  if (settings.sandbox.mode === 'danger-full-access') return { sandboxMode: 'danger-full-access', approvalPolicy: settings.approvalPolicy };
  if (sandboxAvailable) return { sandboxMode: settings.sandbox.mode, approvalPolicy: settings.approvalPolicy };
  if (settings.approvalPolicy === 'never') return { sandboxMode: 'read-only', approvalPolicy: 'never' };
  return { sandboxMode: 'danger-full-access', approvalPolicy: 'unless-trusted' };
}

export default async function guardian(pi: ExtensionAPI): Promise<void> {
  let shell: Awaited<ReturnType<typeof loadShell>>, detection: Awaited<ReturnType<typeof detectPlatformSandbox>>, loaded: LoadedPolicies;
  try {
    [shell, detection, loaded] = await Promise.all([loadShell(), detectPlatformSandbox(), loadPolicies([userRulesDir()])]);
  } catch (error) {
    return registerFailClosed(pi, error);
  }
  const { sandbox, warning: sandboxWarning } = detection;
  const sandboxAvailable = sandbox !== undefined;
  let policies = loaded;
  let contextFiles: { path: string; content: string }[] = [];
  let turn = 0;
  let reviewStatusOwner: object | undefined;
  let auditSession: ExtensionContext['sessionManager'] | undefined;
  const sessionCancellation = new AbortController();
  let cached: { stamp: string; config: GuardianConfig; error?: string } | undefined;
  let lastValid: GuardianConfig | undefined;
  let reportedError: string | undefined;
  /** Set by `/guardian on|off|toggle`. Pi builds a new Guardian for each session, so it never outlives this one. */
  let sessionEnabled: boolean | undefined;

  const fileConfig = (): GuardianConfig => {
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
          : { stamp, config: FAIL_CLOSED_CONFIG, error: `${message}; built-in protections remain; custom connector declarations are unavailable until it is fixed` };
      }
    }
    return cached.config;
  };
  const config = (): GuardianConfig => {
    const settings = fileConfig();
    return sessionEnabled === undefined ? settings : { ...settings, enabled: sessionEnabled };
  };
  const agentPermissions = (settings: GuardianConfig, cwd: string) => permissionsInstructions({
    ...instructedPermissions(settings, sandboxAvailable),
    networkAccess: settings.sandbox.mode === 'host' || settings.sandbox.networkAccess ? 'enabled' : 'restricted',
    reviewer: settings.approvalsReviewer,
    approvedCommandPrefixes: policies.policy.allowedPrefixes(),
    writableRoots: sandboxAvailable && settings.sandbox.mode === 'workspace-write'
      ? workspaceWriteRoots(sandboxPolicyFor(settings), cwd, process.env).map(root => root.root) : [],
  });
  const reportProblems = (ctx: ExtensionContext) => {
    config();
    const problem = cached?.error ?? policies.warning;
    if (problem && problem !== reportedError && ctx.hasUI) ctx.ui.notify(problem, 'warning');
    reportedError = problem;
  };
  const reloadPolicies = async () => { policies = retainPolicies(policies, await loadPolicies([userRulesDir()])); };

  const review = async (input: { actionJson: string; reason?: string }, approvalContext: ApprovalContext, signal?: AbortSignal): Promise<ReviewOutcome> => {
    const ctx = approvalContext as unknown as ExtensionContext;
    const settings = config();
    const sessionId = ctx.sessionManager.getSessionId();
    const statusOwner = {};
    const current = () => auditSession?.getSessionId() === sessionId;
    const claudeCli = settings.reviewer.provider === CLAUDE_CLI_PROVIDER;
    const reviewer = claudeCli ? undefined : resolveReviewer(ctx.modelRegistry, settings.reviewer, `guardian-${sessionId}`);
    if (reviewer && !reviewer.ok) return { type: 'error', error: { type: 'prompt_build', message: reviewer.message } };
    const evidence = collectReviewEvidence(ctx.sessionManager.getBranch(), undefined, { delegated: process.env.PI_SUBAGENT_TIMEOUT_MS !== undefined });
    const transcript = prepareTranscript(evidence.transcript, 0, 'line');
    const plannedAction = { json: input.actionJson, ...(input.reason === undefined ? {} : { reason: input.reason }) };
    const request = composeReviewRequest({
      transcript, sessionId, trustedUserAnswers: evidence.trustedUserAnswers, environmentId: 'local', plannedAction,
      permissionContext: agentPermissions(settings, ctx.cwd),
    });
    const now = new Date();
    const prompt = buildReviewerPrompt({
      ...(settings.autoReview.policy === undefined ? {} : { tenantPolicy: settings.autoReview.policy }),
      extraPolicy: await extraPolicy(settings.autoReview.extraPolicy), contextFiles, cwd: ctx.cwd,
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, request,
    });
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const contextHashes = {
      policy: hash(prompt.systemPrompt), instructions: hash(contextFiles), action: hash(plannedAction),
      transcript: hash({ transcript, trustedUserAnswers: evidence.trustedUserAnswers }),
    };
    if (signal?.aborted || !current()) return { type: 'error', error: { type: 'cancelled' }, contextHashes };
    if (ctx.hasUI) {
      reviewStatusOwner = statusOwner;
      ctx.ui.setStatus(REVIEW_STATUS_KEY, 'Reviewing approval request…');
    }
    try {
      const outcome = await runWithRetry({ maxAttempts: MAX_REVIEW_ATTEMPTS, deadline: Date.now() + REVIEW_TIMEOUT_MS }, signal, deadline => reviewer
        ? runReviewerTurn({ ...prompt, cwd: ctx.cwd, deadline, ...(signal ? { signal } : {}), complete: reviewer.complete,
          runCommand: (command, workdir, commandSignal) => runReadOnlyCommand(command, workdir, commandSignal, sandbox) })
        : runClaudeCliReview({ ...prompt, cwd: ctx.cwd, model: settings.reviewer.model, reasoning: settings.reviewer.reasoning, deadline, ...(signal ? { signal } : {}) }));
      return { ...outcome, contextHashes };
    } finally {
      if (ctx.hasUI && current() && reviewStatusOwner === statusOwner) ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
    }
  };
  const approvals = new Approvals({
    config, review, sessionSignal: sessionCancellation.signal, turnId: () => String(turn),
    record: entry => {
      if (auditSession?.getSessionId() !== entry.sessionId) throw new Error('Cannot record approval audit in a different or closed session');
      pi.appendEntry(APPROVAL_AUDIT_ENTRY_TYPE, entry);
    },
  });

  pi.on('tool_call', createConnectorGate({ config, approvals, tools: () => pi.getAllTools() }));

  const shellSettings = () => {
    const settings = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
    return {
      ...(settings.shellPath === undefined ? {} : { shellPath: settings.shellPath }),
      ...(settings.shellCommandPrefix === undefined ? {} : { commandPrefix: settings.shellCommandPrefix }),
    };
  };
  pi.registerTool(createGuardianBashTool({
    config, policy: () => policies.policy, shellSettings, shell, sandbox, approvals,
    persistAmendment: async prefix => {
      const persistable = persistableAmendment(shell, prefix);
      if (!persistable) return;
      await appendAllowPrefixRule(defaultRulesPath(), persistable);
      await reloadPolicies();
    },
  }, process.cwd()));
  for (const tool of createGuardianFileTools({ config, sandbox, approvals }, process.cwd())) pi.registerTool(tool);

  pi.on('session_start', async (_event, ctx) => {
    auditSession = ctx.sessionManager;
    approvals.clearDenied();
    await reloadPolicies();
    reportedError = undefined;
    reportProblems(ctx);
    if (sandboxWarning && ctx.hasUI && config().enabled && config().sandbox.mode !== 'host') ctx.ui.notify(sandboxWarning, 'warning');
    if (ctx.hasUI && pi.getCommands().some(command => command.name.split(':')[0] === 'auto-permissions')) {
      ctx.ui.notify('Auto Permissions is also loaded, so commands are reviewed twice. Uninstall it to use Guardian alone.', 'warning');
    }
  });
  pi.on('session_shutdown', (_event, ctx) => {
    sessionCancellation.abort();
    reviewStatusOwner = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
    auditSession = undefined;
    approvals.clearDenied();
    approvals.clearTurn(String(turn));
    turn++;
  });
  pi.on('agent_start', (_event, ctx) => {
    turn++;
    reviewStatusOwner = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
  });
  pi.on('agent_end', () => { approvals.clearTurn(String(turn)); });

  pi.on('before_agent_start', (event, ctx) => {
    contextFiles = event.systemPromptOptions.contextFiles;
    reportProblems(ctx);
    const settings = config();
    if (!settings.enabled) return;
    event.systemPromptOptions.sections.permissions_instructions = agentPermissions(settings, ctx.cwd);
  });

  pi.registerCommand('guardian', {
    description: 'Turn Guardian on or off for this session, show its settings or approval history, approve the last denied action, or reload rules',
    getArgumentCompletions: prefix => ['on', 'off', 'toggle', 'status', 'audit', 'approve', 'reload'].filter(name => name.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      const action = args.trim() || 'toggle';
      if (action === 'on' || action === 'off' || action === 'toggle') {
        sessionEnabled = action === 'toggle' ? !config().enabled : action === 'on';
        pi.events.emit(GUARDIAN_ENABLED_EVENT, { enabled: sessionEnabled });
        return sessionEnabled
          ? ctx.ui.notify('Guardian is on for this session.', 'info')
          : ctx.ui.notify('Guardian is off for this session: commands and file changes run without the sandbox or review; connector calls run without review. The Railway and database boundaries still apply. /guardian on turns it back on.', 'warning');
      }
      if (action === 'audit') {
        const entries = ctx.sessionManager.getBranch().flatMap(entry => {
          if (entry.type !== 'custom' || entry.customType !== APPROVAL_AUDIT_ENTRY_TYPE || !entry.data || typeof entry.data !== 'object') return [];
          const data = entry.data as Partial<ApprovalAuditEntry>;
          const { version, timestamp, summary, rationale, requestId, decider, verdict, durationMs } = data;
          if (version !== 1 || typeof timestamp !== 'string' || typeof summary !== 'string' || typeof rationale !== 'string' || typeof requestId !== 'string'
            || !['auto_review', 'user', 'policy'].includes(decider ?? '') || !['approved', 'rejected', 'aborted', 'error'].includes(verdict ?? '')
            || typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return [];
          return [{ timestamp, summary, rationale, requestId, decider, verdict, durationMs }];
        });
        const lines = entries.slice(-20).map(entry => [
          `${entry.timestamp} ${entry.decider}: ${entry.verdict} (${entry.durationMs} ms)`,
          truncateText(entry.summary, 128), truncateText(entry.rationale, 128), `Request: ${entry.requestId}`,
        ].join('\n'));
        return ctx.ui.notify([
          lines.length ? lines.join('\n\n') : 'No Guardian approval decisions recorded on this session branch.',
          ...(entries.length > lines.length ? [`Showing the latest ${lines.length} of ${entries.length} decisions; older entries remain in the session file.`] : []),
          `Session: ${ctx.sessionManager.getSessionFile() ?? 'in memory'}`,
        ].join('\n\n'), 'info');
      }
      if (action === 'approve') {
        const denied = approvals.takeDenied(ctx as unknown as ApprovalContext);
        if (!denied) return ctx.ui.notify('No replayable denied action to approve. Connector calls require approval in chat or a fresh interactive review.', 'info');
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
        return ctx.ui.notify('Usage: /guardian [on|off|toggle|status|audit|approve|reload]', 'warning');
      }
      const settings = config();
      ctx.ui.notify([
        guardianStatusText(settings, sandboxAvailable),
        ...(sessionEnabled === undefined ? [] : [`Turned ${sessionEnabled ? 'on' : 'off'} for this session with /guardian; config.json is unchanged`]),
        `Config: ${guardianConfigPath()}${cached?.error ? ` (${cached.error})` : ''}`,
        `Approvals: ${settings.approvalPolicy}, reviewed by ${settings.approvalsReviewer === 'user' ? 'you' : `${settings.reviewer.provider}/${settings.reviewer.model} (${settings.reviewer.reasoning})`}`,
        settings.sandbox.mode === 'host' ? 'Execution: host with approval checks; network and credentials inherited from Pi'
          : `Sandbox: ${sandbox ? `${settings.sandbox.mode} via ${sandbox.summary}` : `unavailable${sandboxWarning ? ` (${sandboxWarning})` : ' on this platform'}`}, network ${settings.sandbox.networkAccess ? 'on' : 'off'}`,
        `Rules: ${userRulesDir()}${policies.warning ? ` (${policies.warning})` : ''}`,
      ].join('\n'), 'info');
    },
  });
}
