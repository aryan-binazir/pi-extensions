import { join } from 'node:path';
import { ExtensionEditorComponent, SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { terminalLabel } from '../terminal-text.ts';
import { FramedPanel } from '../framed-panel.ts';
import { DelegationAdmission } from './scope.ts';
import { SubagentRegistry } from './registry.ts';
import { TIMEOUT_BOUNDS } from './task.ts';
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
  let approvalUI: Promise<unknown> = Promise.resolve();
  const withApprovalUI = <T>(ctx: ExtensionContext, signal: AbortSignal, show: () => Promise<T>): Promise<T> => {
    if (ctx.mode !== 'tui') return abortable(show(), signal);
    const prompt = approvalUI.then(() => { signal.throwIfAborted(); return show(); });
    approvalUI = prompt.catch(() => {});
    return abortable(prompt, signal);
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
      // Sliced strings can retain the entire task brief.
      label = Buffer.from(terminalLabel(terminalLabel(task).slice(0, 100)), 'utf8').toString('utf8');
      collapsedBriefById.set(id, label);
    }
    return label;
  };
  let paintedPanel: string | undefined;
  let panelPaintKnown = false;
  const panel = new FramedPanel('alt+r', 'truncate');
  const panelSlots = 9;
  const renderActiveAgents = () => {
    if (!context?.hasUI) { collapsedBriefById.clear(); return; }
    const active = registry.isShutdown ? [] : registry.activeTasks().sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
    const visible = active.slice(0, panelSlots);
    const ids = new Set(visible.map(task => task.id));
    for (const id of collapsedBriefById.keys()) if (!ids.has(id)) collapsedBriefById.delete(id);
    const total = active.length, running = active.filter(task => task.status === 'running').length;
    const rows = visible.map(task => [task.id.slice(0, 8), task.status, brief(task.id, task.task)]);
    const rendered = total ? JSON.stringify([panel.expanded, total, running, rows]) : undefined;
    if (panelPaintKnown && rendered === paintedPanel) return;
    panelPaintKnown = true;
    paintedPanel = rendered;
    context.ui.setWidget('interactive-tools:subagents', rendered === undefined ? undefined : (tui, theme) => {
      const blue = (text: string) => theme.fg('border', text);
      const summary = `Subagents · ${running} running · ${total - running} queued · ${blue(panel.shortcut)}`;
      const title = `Subagents · ${total} active · ${blue(panel.shortcut)}`;
      const lines = rows.map(([id, status, task]) => `${id} · ${blue(status)} · ${task}`);
      const panelRows = (slots: number) => {
        const shown = total <= slots ? total : slots - 1;
        const hiddenRunning = Math.max(0, running - shown), hiddenQueued = total - shown - hiddenRunning;
        const more = [hiddenRunning && `${hiddenRunning} ${blue('running')}`, hiddenQueued && `${hiddenQueued} ${blue('queued')}`].filter(Boolean).join(' · ');
        return [...lines.slice(0, shown), ...(shown < total ? [`… ${total - shown} more · ${more}`] : [])];
      };
      return {
        invalidate() { panel.invalidate(); },
        dispose() { panel.invalidate(); },
        render(width: number) {
          return panel.render(width, theme, { summary, title,
            maxHeight: Math.max(5, Math.min(panelSlots + 3, Math.floor((tui?.terminal?.rows || 24) / 2))),
            rows: panelRows,
          });
        },
      };
    });
  };
  pi.registerShortcut(panel.shortcut, {
    description: 'Toggle compact/full subagent panel',
    handler() {
      panel.toggle();
      renderActiveAgents();
    },
  });
  const createRegistry = () => new SubagentRegistry({
    admission,
    notify: (content, options) => pi.sendMessage({customType: 'subagent-complete', content, display: true}, options),
    activity: event => {
      if (event.background) { pi.events.emit('pi-interactive:background-activity', event.background); return; }
      if (event.tasks) renderActiveAgents();
      if (event.tracker === 'stop' || event.tasks === 'completed' && !registry.hasActive()) {
        if (context?.hasUI) context.ui.setStatus('subagent-tracker', undefined);
      }
      if (event.tracker === 'stop') {
        tracker.stop();
        if (registry.isShutdown) latestReport = undefined;
      } else if (event.tracker === 'invalidate') tracker.invalidate();
      else if (event.tracker === 'update') tracker.update();
    },
  });
  let registry = createRegistry();
  let latestReport: string | undefined;
  const tracker = new SubagentTracker(() => context, () => registry.list(), report => {
    latestReport = sanitizeTrackerReport(report);
    if (context?.hasUI) context.ui.setStatus('subagent-tracker', trackerFooter(report, process.stdout.columns));
  });
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
    if (registry.isShutdown) registry = createRegistry();
  });
  pi.on('session_shutdown', () => registry.shutdown());
  const cancelTasks = async (id: string) => {
    if (id === 'all') return registry.cancelAll();
    const cancelled = registry.cancel(id);
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
      const handle = await registry.spawn(task, signal, 'parent', bridge);
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
      const cwd = ctx.cwd;
      return result(await registry.track(async workflowSignal => {
        const workflowAdmission = admission.workflow(ctx, workflowSignal);
        return runWorkflow({
          source: params.source, cwd, timeout: params.timeout, signal: workflowSignal,
          journalDirectory: join(getAgentDir(), 'workflow-journals'), admission: workflowAdmission,
          approve: ctx.hasUI ? async source => {
            const title = 'Review workflow TypeScript; submit unchanged source to continue';
            const reviewed = await withApprovalUI(ctx, workflowSignal, async () => {
              if (ctx.mode !== 'tui') return ctx.ui.editor(title, source);
              const draft = ctx.ui.getEditorText();
              return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
                const cleanup = () => workflowSignal.removeEventListener('abort', abort);
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
                workflowSignal.addEventListener('abort', abort, {once: true});
                if (workflowSignal.aborted) abort();
                return editor;
  
            });
            });
            return reviewed === source && await withApprovalUI(ctx, workflowSignal, () => ctx.ui.confirm('Execute this exact workflow?', 'The displayed source may spawn tasks and read bounded workspace files. Successful stages will be journaled for replay.', {signal: workflowSignal}));
          } : undefined,
          approveReplay: ctx.hasUI ? stages => withApprovalUI(ctx, workflowSignal, () => ctx.ui.confirm('Replay previously successful stages?', `These stages will NOT run again: ${stages.join(', ')}. Approve only if their outputs and side effects remain valid in the current workspace.`, {signal: workflowSignal})) : async () => false,
          spawn: async (task, taskSignal) => {
            taskSignal.throwIfAborted();
            const request = workflowAdmission.request(task);
            const handle = await registry.spawn(request.task, taskSignal, 'workflow', request.bridge);
            const cancel = () => registry.cancel(handle.id);
            taskSignal.addEventListener('abort', cancel, { once: true });
            if (taskSignal.aborted) cancel();
            try {
              const value = await handle.done;
              if (value.status !== 'succeeded') throw Object.assign(new Error(`Subagent ${value.status}: ${value.error ?? value.stderr}`), {retryable: value.status === 'failed'});
              return {...value, stderr: clipJson(value.stderr, 4096, true)};
            } finally {
              taskSignal.removeEventListener('abort', cancel);
            }
          },
        });
      }, signal));
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
