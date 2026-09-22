import { join, resolve } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { assertChildTask, delegationScope, assertWorkflowRead } from './scope.ts';
import { getActiveCwd } from '../worktree/routing.ts';
import { piInvocation, SubagentRegistry, TIMEOUT_BOUNDS, type TaskSpec } from './registry.ts';
import { thinkingPattern } from './thinking.ts';
import { runWorkflow } from './workflow.ts';
import { clipJson, taskView } from './presentation.ts';
import { abortable } from './cancellation.ts';
import { SubagentTracker } from './tracker.ts';
import { sanitizeTrackerReport, trackerFooter } from './tracker-footer.ts';
import { availableModel, assertTaskFields, loadProfiles, profileGuidance, profileLocation, resolveProfile, type ProfileConfig } from './profiles.ts';

const taskSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 32000 }), cwd: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String({maxLength: 48})),
  model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String({pattern: `^${thinkingPattern}$`})), preset: Type.Optional(Type.Union([Type.Literal('reader'), Type.Literal('writer')])),
  tools: Type.Optional(Type.Array(Type.String())), extensions: Type.Optional(Type.Array(Type.String())), timeout: Type.Optional(Type.Integer(TIMEOUT_BOUNDS)),
}, {additionalProperties: false});
const completionGuidance = 'After calling subagent, do independent work or end your turn. Completion results are pushed automatically and resume the parent without polling. Do not call subagent_status or run sleep/wait loops just to await completion.';
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });

export default function subagents(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let shuttingDown = false;
  let cancellingAll = false;
  const workflows = new Set<AbortController>();
  const workflowRuns = new Set<Promise<unknown>>();
  let notices: ReturnType<typeof taskView>[] = [];
  let overflowNotices = 0;
  let noticeTriggersTurn = false;
  let noticeTimer: NodeJS.Timeout | undefined;
  const flushNotices = () => {
    const pending = notices;
    const count = pending.length + overflowNotices;
    const triggerTurn = noticeTriggersTurn;
    notices = []; overflowNotices = 0; noticeTriggersTurn = false; noticeTimer = undefined;
    if (shuttingDown || !count) return;
    const tasks: ReturnType<typeof taskView>[] = [];
    for (const notice of pending) {
      const output = clipJson(notice.output, 1024, true);
      const compact = {...notice, output, outputTruncated: notice.outputTruncated || output.length < notice.output.length};
      if (Buffer.byteLength(JSON.stringify([...tasks, compact]), 'utf8') <= 12000) tasks.push(compact);
    }
    const value = count === 1 ? pending[0] : {tasks, additionalCompletions: count - tasks.length};
    try { pi.sendMessage({customType: 'subagent-complete', content: JSON.stringify(value), display: true}, {triggerTurn, deliverAs: triggerTurn ? 'followUp' : 'nextTurn'}); }
    catch (error) { registry.notificationFailed(pending.map(task => task.id), error); }
  };
  const parent = () => ({ cwd: getActiveCwd(context?.cwd ?? process.cwd(), context?.sessionManager.getSessionId()), tools: pi.getActiveTools() });
  // A brief never changes for an id, so its collapsed form is derived once
  // rather than on every repaint of a panel that updates ten times a second.
  const briefs = new Map<string, string>();
  const brief = (id: string, task: string) => {
    let label = briefs.get(id);
    if (label === undefined) {
      if (briefs.size > 1024) briefs.clear();
      label = task.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      briefs.set(id, label);
    }
    return label;
  };
  // null until the panel's on-screen state is known; an unchanged panel is not
  // repainted, so a silently streaming child costs nothing here.
  let painted: string | undefined | null = null;
  const renderActiveAgents = () => {
    if (!context?.hasUI) return;
    const active = shuttingDown ? [] : registry.activeTasks();
    const rows = active.map(task => [task.id.slice(0, 8), task.status, brief(task.id, task.task)]);
    const rendered = active.length ? JSON.stringify(rows) : undefined;
    if (rendered === painted) return;
    painted = rendered;
    context.ui.setWidget('interactive-tools:subagents', rendered === undefined ? undefined : (_tui, theme) => {
      const blue = (text: string) => theme.fg('border', text);
      const lines = [`Subagents · ${rows.length} active`, ...rows.map(([id, status, task]) => `${id} · ${blue(status)} · ${task}`)];
      return {
        invalidate() {},
        render(width: number) {
          const inner = Math.max(1, width - 4);
          return [
            blue(`╭${'─'.repeat(inner + 2)}╮`),
            ...lines.flatMap(line => wrapTextWithAnsi(line, inner)).map(line => `${blue('│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${blue('│')}`),
            blue(`╰${'─'.repeat(inner + 2)}╯`),
          ];
        },
      };
    });
  };
  const createRegistry = () => new SubagentRegistry({
    allowedTools: () => delegationScope(parent()).tools,
    authorize: async task => { await assertChildTask(task, { parent: parent(), approve: context?.hasUI ? async request => await context!.ui.confirm('Approve local child extensions', request) : undefined }); },
    invocation: task => {
      if (context && task.configProvenance) {
        if (task.configProvenance.config !== configFor(context).identity) throw new Error('Subagent configuration or trust changed while queued; resubmit task');
        availableModel(task.model!, context.modelRegistry, task.profile);
      }
      return piInvocation(task);
    },
    onUpdate: renderActiveAgents,
    onComplete: task => {
      renderActiveAgents();
      if (context?.hasUI && !registry.hasActive()) context.ui.setStatus('subagent-tracker', undefined);
      if (shuttingDown || cancellingAll || task.owner !== 'parent') return;
      noticeTriggersTurn ||= task.status !== 'cancelled';
      if (notices.length < 16) notices.push(taskView(task, 4096)); else overflowNotices++;
      noticeTimer ??= setTimeout(flushNotices, 250);
    },
  });
  let registry = createRegistry();
  let latestReport: string | undefined;
  const tracker = new SubagentTracker(() => context, () => registry.list(), report => {
    latestReport = sanitizeTrackerReport(report);
    // Observations are transient UI, never new conversation/model messages.
    // One stable footer slot replaces earlier reports, even when they change.
    // setStatus has no width callback; use the terminal width when available,
    // without replacing Pi's footer or interfering with other status slots.
    if (context?.hasUI) context.ui.setStatus('subagent-tracker', trackerFooter(report, process.stdout.columns));
  });
  const trackedSpawn = async (task: TaskSpec, signal?: AbortSignal, owner: 'parent' | 'workflow' = 'parent') => {
    const handle = await registry.spawn(task, signal, owner);
    renderActiveAgents();
    if (!shuttingDown && !cancellingAll) tracker.update();
    const invalidate = () => { if (!shuttingDown && !cancellingAll) tracker.invalidate(); };
    signal?.addEventListener('abort', invalidate, {once: true});
    if (signal?.aborted) invalidate();
    void handle.done.then(task => {
      signal?.removeEventListener('abort', invalidate);
      renderActiveAgents();
      if (!shuttingDown && !cancellingAll) {
        if (task.status === 'cancelled') tracker.invalidate(); else tracker.update();
      }
    });
    pi.events.emit('pi-interactive:background-activity', { id: handle.id, active: true });
    void handle.done.then(() => pi.events.emit('pi-interactive:background-activity', { id: handle.id, active: false }));
    return handle;
  };
  let snapshot: ProfileConfig | undefined;
  let configError: Error | undefined;
  let locationKey = '';
  const configFor = (ctx: ExtensionContext, reload = false): ProfileConfig => {
    const location = profileLocation(ctx, getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()));
    const key = JSON.stringify(location);
    if (reload || key !== locationKey) {
      locationKey = key; snapshot = undefined; configError = undefined;
      try { snapshot = loadProfiles(location.cwd, location.trusted); }
      catch (error) { configError = error instanceof Error ? error : new Error(String(error)); }
      registerSubagent(snapshot);
    }
    if (configError) throw configError;
    return snapshot!;
  };
  const normalize = (task: Omit<TaskSpec, 'cwd'> & {cwd?: string}, ctx: ExtensionContext, config = configFor(ctx)): TaskSpec => {
    assertTaskFields(task);
    if (task.cwd !== undefined && typeof task.cwd !== 'string') throw new Error('Invalid child cwd');
    return resolveProfile({...task, cwd: resolve(getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()), task.cwd ?? '.')}, config, ctx);
  };
  pi.on('before_agent_start', (event, ctx) => {
    if (!pi.getActiveTools().some(tool => tool === 'subagent' || tool === 'workflow')) return;
    let guidance: string;
    try { guidance = profileGuidance(configFor(ctx), ctx); }
    catch (error) { guidance = `Subagent delegation is unavailable: ${String(error)}`; }
    return {systemPrompt: `${event.systemPrompt}\n\n${guidance}`};
  });
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    try { configFor(ctx, true); } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); }
    painted = null;
    if (shuttingDown) {
      registry = createRegistry();
      shuttingDown = false;
    }
  });
  /** Drop the tracker footer and any completion notices batched for the parent. */
  const stopReporting = () => {
    tracker.stop();
    if (context?.hasUI) context.ui.setStatus('subagent-tracker', undefined);
    clearTimeout(noticeTimer); noticeTimer = undefined; notices = []; overflowNotices = 0; noticeTriggersTurn = false;
  };
  const stopAll = async () => {
    shuttingDown = true;
    latestReport = undefined;
    renderActiveAgents();
    stopReporting();
    for (const controller of workflows) controller.abort();
    await registry.shutdown();
    await Promise.allSettled(workflowRuns);
  };
  pi.on('session_shutdown', stopAll);
  const cancelTasks = async (id: string) => {
    if (id === 'all') {
      cancellingAll = true;
      stopReporting();
      const runs = [...workflowRuns];
      for (const controller of workflows) controller.abort();
      try {
        const count = await registry.cancelAll();
        await Promise.allSettled(runs);
        return {cancelled: count > 0, count};
      } finally {
        cancellingAll = false;
        if (!shuttingDown) tracker.update();
      }
    }
    const cancelled = registry.cancel(id);
    if (cancelled) tracker.invalidate();
    await registry.wait(id);
    return {cancelled};
  };
  const registerSubagent = (config?: ProfileConfig) => pi.registerTool({
    name: 'subagent', label: 'Subagent', description: 'Start a background Pi agent with only an explicit task brief, a validated workspace, and bounded tools. Returns task ID immediately; completion is pushed into this conversation. Context separation is not an OS sandbox. Same-directory writers serialize. Explicit child extensions may contribute hooks and commands; their custom tools are excluded by the built-in tool allowlist.' + (config ? ` Profiles: ${Object.keys(config.profiles).join(', ')}; default: ${config.defaultProfile}.` : ''), parameters: taskSchema,
    promptGuidelines: [completionGuidance, 'The subagent extension automatically runs a shared report-only Luna tracker. Do not launch or poll a watcher; worker results arrive directly, independently of tracker reports.'],
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      context = ctx;
      const task = normalize(params, ctx);
      if (!task.model) throw new Error('A selected parent model or explicit provider/model is required');
      const handle = await trackedSpawn(task, signal);
      return result({ id: handle.id, status: 'queued', notification: completionGuidance });
    },
  });
  registerSubagent();
  pi.registerTool({
    name: 'subagent_status', label: 'Subagent status', description: 'Inspect bounded subagent summaries (up to 10 per page), or output detail by id (up to 8 KiB JSON text). Use offset/limit for summary pages and outputOffset/nextOutputOffset for retained output pages. Output offsets count UTF-16 code units. Completion notifications are automatic; do not poll for completion. Use subagent_status only for a requested progress check, debugging, or retrieving omitted/truncated results.', parameters: Type.Object({id: Type.Optional(Type.String({maxLength: 100})), offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 10})), outputOffset: Type.Optional(Type.Integer({minimum: 0, maximum: 65536}))}),
    async execute(_id, params = {}) {
      const trackedResult = (value: unknown) => {
        const bounded = result(value);
        return {...bounded, tracker: tracker.status, content: [...bounded.content, {type: 'text' as const, text: tracker.status}]};
      };
      if (params.id) {
        const task = registry.get(params.id);
        if (!task) throw new Error('Unknown or no longer retained subagent id');
        return trackedResult(taskView(task, 8192, params.outputOffset ?? 0));
      }
      return trackedResult(registry.list(params.offset ?? 0, params.limit ?? 10).map(task => taskView(task)));
    },
  });
  pi.registerTool({
    name: 'subagent_cancel', label: 'Cancel subagent', description: 'Cancel a subagent by id, or use id "all" to stop current children and workflows. Waits for supervised process cleanup; does not disable future delegation.', parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) { return result(await cancelTasks(params.id)); },
  });
  pi.registerTool({
    name: 'workflow', label: 'TypeScript workflow', description: 'Compile and run an explicitly user-approved TypeScript async function body. api exposes spawn(task, stableStageLabel), parallel(array of async functions), retry(attempts, async function), checkpoint(key, async function), bounded readFile(path,maxBytes). Successful stages replay only with identical approved source, cwd, and tool scope. api.spawn accepts the same task/profile/model/thinking/preset/tools/extensions/cwd/timeout as subagent. Requires interactive source review.',
    parameters: Type.Object({ source: Type.String({ minLength: 1, maxLength: 64000 }), timeout: Type.Optional(Type.Integer(TIMEOUT_BOUNDS)) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      context = ctx;
      const controller = new AbortController();
      workflows.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const cwd = getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId());
      try {
        const config = configFor(ctx);
        const selectionContext = {model: ctx.model, thinkingLevel: ctx.thinkingLevel, modelRegistry: ctx.modelRegistry};
        const run = runWorkflow({
          source: params.source, cwd, timeout: params.timeout, signal: controller.signal,
          journalDirectory: join(getAgentDir(), 'workflow-journals'), policyIdentity: delegationScope(parent()).replayIdentity,
          allowedTools: () => delegationScope(parent()).tools,
          defaultTask: {model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`, thinking: ctx.thinkingLevel},
          profileIdentity: config.identity,
          normalizeTask: task => {
            if (configFor(ctx).identity !== config.identity || getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()) !== cwd) throw new Error('Workflow configuration or workspace changed; restart workflow');
            return resolveProfile(task, config, selectionContext);
          },
          approve: ctx.hasUI ? async source => {
            const reviewed = await abortable(ctx.ui.editor('Review workflow TypeScript; submit unchanged source to continue', source), controller.signal);
            return reviewed === source && await ctx.ui.confirm('Execute this exact workflow?', 'The displayed source may spawn tasks and read bounded workspace files. Successful stages will be journaled for replay.', {signal: controller.signal});
          } : undefined,
          validateTask: async task => { await assertChildTask(task, { parent: parent(), approve: ctx.hasUI ? request => ctx.ui.confirm('Approve workflow child extensions', request) : undefined }); },
          approveReplay: ctx.hasUI ? stages => ctx.ui.confirm('Replay previously successful stages?', `These stages will NOT run again: ${stages.join(', ')}. Approve only if their outputs and side effects remain valid in the current workspace.`) : async () => false,
          authorizeRead: path => assertWorkflowRead(parent(), path),
          spawn: async (task, taskSignal) => {
            taskSignal.throwIfAborted();
            const handle = await trackedSpawn(task, taskSignal, 'workflow');
            const cancel = () => registry.cancel(handle.id);
            taskSignal.addEventListener('abort', cancel, { once: true });
            if (taskSignal.aborted) cancel();
            try {
              const value = await handle.done;
              if (value.status !== 'succeeded') throw Object.assign(new Error(`Subagent ${value.status}: ${value.error ?? value.stderr}`), {retryable: value.status === 'failed'});
              return value;
            } finally {
              taskSignal.removeEventListener('abort', cancel);
            }
          },
        });
        workflowRuns.add(run);
        try {
          return result(await run);
        } finally {
          workflowRuns.delete(run);
        }
      } finally {
        controller.abort();
        workflows.delete(controller);
        signal?.removeEventListener('abort', abort);
      }
    },
  });
  pi.registerCommand('subagents', {
    description: 'Show background agents and latest report or cancel: /subagents [cancel ID|all]', handler: async (args, ctx) => {
      context = ctx;
      const [command, id] = args.trim().split(/\s+/);
      if (command === 'cancel' && id) ctx.ui.notify((await cancelTasks(id)).cancelled ? 'Cancellation completed' : 'No active task with that ID', 'info');
      else ctx.ui.notify(JSON.stringify({tasks: registry.list().map(({ id, status, usage }) => ({ id, status, usage })), tracker: tracker.status, latestReport: latestReport ?? null}), 'info');
    },
  });
}
