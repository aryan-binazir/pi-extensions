import { join } from 'node:path';
import { ExtensionEditorComponent, SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { terminalLabel } from '../terminal-text.ts';
import { DelegationAdmission } from './scope.ts';
import type {ConnectorBridge} from './connector-bridge.ts';
import { SubagentRegistry } from './registry.ts';
import { TIMEOUT_BOUNDS, type TaskSpec } from './task.ts';
import { thinkingPattern } from './thinking.ts';
import { runWorkflow } from './workflow.ts';
import { clipJson, taskView } from './presentation.ts';
import { abortable } from './cancellation.ts';
import { SubagentTracker } from './tracker.ts';
import { sanitizeTrackerReport, trackerFooter } from './tracker-footer.ts';
import { loadProfiles, profileGuidance, profileLocation, type ProfileConfig } from './profiles.ts';

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
  const cancelledByAll = new Set<string>();
  const workflows = new Set<AbortController>();
  const workflowRuns = new Set<Promise<unknown>>();
  let approvalUI: Promise<unknown> = Promise.resolve();
  const withApprovalUI = <T>(ctx: ExtensionContext, signal: AbortSignal, show: () => Promise<T>): Promise<T> => {
    if (ctx.mode !== 'tui') return abortable(show(), signal);
    const prompt = approvalUI.then(() => { signal.throwIfAborted(); return show(); });
    approvalUI = prompt.catch(() => {});
    return abortable(prompt, signal);
  };
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
  const admission = new DelegationAdmission({
    cwd: () => context?.cwd ?? process.cwd(), tools: () => pi.getActiveTools(),
    definitions: pi.getAllTools ? () => pi.getAllTools() : undefined,
    grants: () => snapshot?.delegatedTools, selection: () => context,
    config: ctx => configFor(ctx),
    approve: (title, request, signal, ctx = context!) => withApprovalUI(ctx, signal, () => ctx.ui.confirm(title, request, {signal})),
  });
  const collapsedBriefById = new Map<string, string>();
  const brief = (id: string, task: string) => {
    let label = collapsedBriefById.get(id);
    if (label === undefined) {
      if (collapsedBriefById.size > 1024) collapsedBriefById.clear();
      label = terminalLabel(terminalLabel(task).slice(0, 100));
      collapsedBriefById.set(id, label);
    }
    return label;
  };
  let paintedPanel: string | undefined;
  let panelPaintKnown = false;
  let expanded = false;
  const panelSlots = 9;
  const renderActiveAgents = () => {
    if (!context?.hasUI) return;
    const active = shuttingDown ? [] : registry.activeTasks().sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
    const total = active.length, running = active.filter(task => task.status === 'running').length;
    const rows = active.slice(0, panelSlots).map(task => [task.id.slice(0, 8), task.status, brief(task.id, task.task)]);
    const rendered = total ? JSON.stringify([expanded, total, running, rows]) : undefined;
    if (panelPaintKnown && rendered === paintedPanel) return;
    panelPaintKnown = true;
    paintedPanel = rendered;
    context.ui.setWidget('interactive-tools:subagents', rendered === undefined ? undefined : (tui, theme) => {
      const blue = (text: string) => theme.fg('border', text);
      const summary = `Subagents · ${running} running · ${total - running} queued · ${blue('alt+r')}`;
      const lines = [`Subagents · ${total} active · ${blue('alt+r')}`, ...rows.map(([id, status, task]) => `${id} · ${blue(status)} · ${task}`)];
      return {
        invalidate() {},
        render(width: number) {
          if (width < 6) return [];
          if (!expanded) return [truncateToWidth(summary, width)];
          const inner = width - 4;
          const slots = Math.max(2, Math.min(panelSlots, Math.floor((tui?.terminal?.rows || 24) / 2) - 3));
          const shown = total <= slots ? total : slots - 1;
          const hiddenRunning = Math.max(0, running - shown), hiddenQueued = total - shown - hiddenRunning;
          const more = [hiddenRunning && `${hiddenRunning} ${blue('running')}`, hiddenQueued && `${hiddenQueued} ${blue('queued')}`].filter(Boolean).join(' · ');
          return [
            blue(`╭${'─'.repeat(inner + 2)}╮`),
            ...[...lines.slice(0, shown + 1), ...(shown < total ? [`… ${total - shown} more · ${more}`] : [])].map(line => `${blue('│')} ${truncateToWidth(line, inner, '…', true)} ${blue('│')}`),
            blue(`╰${'─'.repeat(inner + 2)}╯`),
          ];
        },
      };
    });
  };
  pi.registerShortcut('alt+r', {
    description: 'Toggle compact/full subagent panel',
    handler() {
      expanded = !expanded;
      renderActiveAgents();
    },
  });
  const createRegistry = () => new SubagentRegistry({
    admission,
    onUpdate: renderActiveAgents,
    onComplete: task => {
      renderActiveAgents();
      if (context?.hasUI && !registry.hasActive()) context.ui.setStatus('subagent-tracker', undefined);
      if (cancelledByAll.delete(task.id) || shuttingDown || task.owner !== 'parent') return;
      noticeTriggersTurn ||= task.status !== 'cancelled';
      if (notices.length < 16) notices.push(taskView(task, 4096)); else overflowNotices++;
      noticeTimer ??= setTimeout(flushNotices, 250);
    },
  });
  let registry = createRegistry();
  let latestReport: string | undefined;
  const tracker = new SubagentTracker(() => context, () => registry.list(), report => {
    latestReport = sanitizeTrackerReport(report);
    if (context?.hasUI) context.ui.setStatus('subagent-tracker', trackerFooter(report, process.stdout.columns));
  });
  const trackedSpawn = async (task: TaskSpec, signal?: AbortSignal, owner: 'parent' | 'workflow' = 'parent', bridge?: ConnectorBridge) => {
    const handle = await registry.spawn(task, signal, owner, bridge);
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
    const location = profileLocation(ctx, ctx.cwd);
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
  pi.on('before_agent_start', (event, ctx) => {
    if (!pi.getActiveTools().some(tool => tool === 'subagent' || tool === 'workflow')) return;
    let guidance: string;
    try { guidance = profileGuidance(configFor(ctx), ctx); }
    catch (error) { guidance = `Subagent delegation is unavailable: ${String(error)}`; }
    event.systemPromptOptions.sections.subagent_profiles = guidance;
  });
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    try { configFor(ctx, true); } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); }
    panelPaintKnown = false;
    if (shuttingDown) {
      registry = createRegistry();
      shuttingDown = false;
    }
  });
  const stopReporting = () => {
    tracker.stop();
    if (context?.hasUI) context.ui.setStatus('subagent-tracker', undefined);
  };
  const stopAll = async () => {
    shuttingDown = true;
    latestReport = undefined;
    renderActiveAgents();
    stopReporting();
    clearTimeout(noticeTimer); noticeTimer = undefined; notices = []; overflowNotices = 0; noticeTriggersTurn = false;
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
      const activeWorkflows = [...workflows].filter(controller => !controller.signal.aborted);
      try {
        for (const task of registry.activeTasks()) cancelledByAll.add(task.id);
        const cancelChildren = registry.cancelAll();
        for (const controller of activeWorkflows) controller.abort();
        const count = await cancelChildren;
        await Promise.allSettled(runs);
        return {cancelled: count > 0 || activeWorkflows.length > 0, count};
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
    name: 'subagent', label: 'Subagent', description: 'Start a background Pi agent with an explicit task brief, validated workspace, and bounded tools. Returns task ID immediately; completion is pushed here. Built-in defaults stay within parent permissions. Connector tools must be requested explicitly in tools, have exact read/write grants in user-scoped subagents.json delegatedTools, and be active and callable in the parent. Reader presets reject write grants. Selected connectors execute through parent permission checks via child proxies; connector credentials stay in the parent. Requires Pi 0.99.1+ tools/executeTool support. Explicit child extensions require approval and cannot add tools outside the selected names. Context separation is not an OS sandbox. Same-directory writers serialize.' + (config ? ` Profiles: ${Object.keys(config.profiles).join(', ')}; default: ${config.defaultProfile}. Connector grants: ${Object.entries(config.delegatedTools).map(([name, grant]) => `${name} (${grant})`).join(', ') || 'none'}.` : ''), parameters: taskSchema,
    promptGuidelines: [completionGuidance, 'The subagent extension automatically runs a shared report-only Luna tracker. Do not launch or poll a watcher; worker results arrive directly, independently of tracker reports.'],
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      context = ctx;
      const {task, bridge} = admission.direct(params, ctx);
      const handle = await trackedSpawn(task, signal, 'parent', bridge);
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
    name: 'workflow', label: 'TypeScript workflow', description: 'Compile and run an explicitly user-approved TypeScript async function body. api exposes spawn(task, stableStageLabel), parallel(array of async functions), retry(attempts, async function), checkpoint(key, async function), bounded readFile(path,maxBytes). Successful stages replay only with identical approved source, cwd, and tool scope. api.spawn accepts the same task/profile/model/thinking/preset/tools/extensions/cwd/timeout and connector delegation contract as subagent. Connector tools need explicit tools selection, exact read/write grants in user-scoped subagents.json delegatedTools, and active/callable parent permissions. Reader presets reject write grants. Requires interactive source review.',
    parameters: Type.Object({ source: Type.String({ minLength: 1, maxLength: 64000 }), timeout: Type.Optional(Type.Integer(TIMEOUT_BOUNDS)) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      context = ctx;
      const controller = new AbortController();
      workflows.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const cwd = ctx.cwd;
      try {
        const workflowAdmission = admission.workflow(ctx, controller.signal);
        const run = runWorkflow({
          source: params.source, cwd, timeout: params.timeout, signal: controller.signal,
          journalDirectory: join(getAgentDir(), 'workflow-journals'), admission: workflowAdmission,
          approve: ctx.hasUI ? async source => {
            const title = 'Review workflow TypeScript; submit unchanged source to continue';
            const reviewed = await withApprovalUI(ctx, controller.signal, async () => {
              if (ctx.mode !== 'tui') return ctx.ui.editor(title, source);
              const draft = ctx.ui.getEditorText();
              return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
                const cleanup = () => controller.signal.removeEventListener('abort', abort);
                let finished = false;
                const finish = (value?: string) => {
                  if (finished) return;
                  finished = true;
                  cleanup();
                  done(value);
                  ctx.ui.setEditorText(draft);
                };
                const abort = () => finish();
                const settings: unknown = 'getSettings' in pi && typeof pi.getSettings === 'function' ? pi.getSettings() : undefined;
                const externalEditor = settings && typeof settings === 'object' && 'externalEditor' in settings
                  ? typeof settings.externalEditor === 'string' && settings.externalEditor.trim() ? settings.externalEditor : undefined
                  : settings === undefined ? SettingsManager.create(ctx.cwd, getAgentDir(), {projectTrusted: ctx.isProjectTrusted?.() === true}).getExternalEditorCommand() : undefined;
                const editor = Object.assign(new ExtensionEditorComponent(tui, keybindings, title, source, finish, abort, undefined, externalEditor), {dispose: cleanup});
                controller.signal.addEventListener('abort', abort, {once: true});
                if (controller.signal.aborted) abort();
                return editor;
  
            });
            });
            return reviewed === source && await withApprovalUI(ctx, controller.signal, () => ctx.ui.confirm('Execute this exact workflow?', 'The displayed source may spawn tasks and read bounded workspace files. Successful stages will be journaled for replay.', {signal: controller.signal}));
          } : undefined,
          approveReplay: ctx.hasUI ? stages => withApprovalUI(ctx, controller.signal, () => ctx.ui.confirm('Replay previously successful stages?', `These stages will NOT run again: ${stages.join(', ')}. Approve only if their outputs and side effects remain valid in the current workspace.`, {signal: controller.signal})) : async () => false,
          spawn: async (task, taskSignal) => {
            taskSignal.throwIfAborted();
            const request = workflowAdmission.request(task);
            const handle = await trackedSpawn(request.task, taskSignal, 'workflow', request.bridge);
            const cancel = () => registry.cancel(handle.id);
            taskSignal.addEventListener('abort', cancel, { once: true });
            if (taskSignal.aborted) cancel();
            try {
              const value = await handle.done;
              if (value.status !== 'succeeded') throw Object.assign(new Error(`Subagent ${value.status}: ${value.error ?? value.stderr}`), {retryable: value.status === 'failed'});
              // Journaled and replayed as returned: keep only a stderr tail so a stage record stays within its 1 MiB budget.
              return {...value, stderr: clipJson(value.stderr, 4096, true)};
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
