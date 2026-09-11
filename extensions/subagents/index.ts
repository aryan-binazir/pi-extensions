import { join, resolve } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { assertChildTask, childPolicy, checkAction } from '../auto-mode/policy.ts';
import { getActiveCwd } from '../worktree/routing.ts';
import { piInvocation, SubagentRegistry, type TaskSpec } from './registry.ts';
import { runWorkflow } from './workflow.ts';

const taskSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 32000 }), cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), preset: Type.Optional(Type.Union([Type.Literal('reader'), Type.Literal('writer')])),
  tools: Type.Optional(Type.Array(Type.String())), extensions: Type.Optional(Type.Array(Type.String())), timeout: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600000 })),
});
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });

export default function subagents(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let shuttingDown = false;
  const workflows = new Set<AbortController>();
  const workflowRuns = new Set<Promise<unknown>>();
  const createRegistry = () => new SubagentRegistry({
    authorize: async task => { await assertChildTask(task, { approve: context?.hasUI ? async request => await context!.ui.confirm('Approve local child extensions', request) : undefined }, context?.sessionManager.getSessionId()); },
    invocation: task => piInvocation(task, childPolicy(task.cwd, task.tools, context?.sessionManager.getSessionId())),
    onUpdate: task => {
      if (context?.hasUI) context.ui.setWidget(`subagent:${task.id}`, [`${task.id.slice(0, 8)} · ${task.status} · ${task.usage.input} in / ${task.usage.output} out`, task.output.slice(-2000)]);
    },
    onComplete: task => {
      if (context?.hasUI) context.ui.setWidget(`subagent:${task.id}`, undefined);
      if (!shuttingDown) pi.sendMessage({ customType: 'subagent-complete', content: JSON.stringify(task), display: true }, { triggerTurn: true, deliverAs: 'followUp' });
    },
  });
  let registry = createRegistry();
  const normalize = (task: Omit<TaskSpec, 'cwd'> & { cwd?: string }, ctx: ExtensionContext): TaskSpec => ({ ...task, cwd: resolve(getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()), task.cwd ?? '.') });
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    if (shuttingDown) {
      registry = createRegistry();
      shuttingDown = false;
    }
  });
  const stopAll = async () => {
    shuttingDown = true;
    for (const controller of workflows) controller.abort();
    await registry.shutdown();
    await Promise.allSettled(workflowRuns);
  };
  pi.on('session_shutdown', stopAll);
  // A before-switch handler can cancel the switch; committed switches emit shutdown.
  pi.registerTool({
    name: 'subagent', label: 'Subagent', description: 'Start a background Pi agent with only an explicit task brief, bounded tools, and inherited policy. Returns task ID immediately; completion is pushed into this conversation. Context separation is not an OS sandbox. Same-directory writers serialize. Explicit child extensions may contribute hooks and commands; their custom tools are excluded by the built-in tool allowlist.', parameters: taskSchema,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      context = ctx;
      const handle = await registry.spawn(normalize(params, ctx));
      if (signal?.aborted) registry.cancel(handle.id);
      return result({ id: handle.id, status: 'queued', notification: 'Completion will be delivered automatically' });
    },
  });
  pi.registerTool({
    name: 'subagent_status', label: 'Subagent status', description: 'Inspect streamed output, usage, and lifecycle state of session subagents. Completion notifications are automatic; no polling needed.', parameters: Type.Object({}),
    async execute() { return result(registry.list()); },
  });
  pi.registerTool({
    name: 'subagent_cancel', label: 'Cancel subagent', description: 'Cancel a queued or running subagent and reap its subprocess tree.', parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) { return result({ cancelled: registry.cancel(params.id) }); },
  });
  pi.registerTool({
    name: 'workflow', label: 'TypeScript workflow', description: 'Compile and run an explicitly user-approved TypeScript async function body. api exposes spawn(task, stableStageLabel), parallel(array of async functions), retry(attempts, async function), checkpoint(key, async function), bounded readFile(path,maxBytes). Successful stages replay only with identical approved source, cwd, and inherited policy. Requires interactive source review.',
    parameters: Type.Object({ source: Type.String({ minLength: 1, maxLength: 64000 }), timeout: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600000 })) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      context = ctx;
      const controller = new AbortController();
      workflows.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const cwd = getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId());
      try {
        const run = runWorkflow({
          source: params.source, cwd, timeout: params.timeout, signal: controller.signal,
          journalDirectory: join(getAgentDir(), 'workflow-journals'), policyIdentity: JSON.stringify(childPolicy(cwd, undefined, ctx.sessionManager.getSessionId()).env),
          approve: ctx.hasUI ? async source => {
            const reviewed = await ctx.ui.editor('Review workflow TypeScript; submit unchanged source to continue', source);
            return reviewed === source && await ctx.ui.confirm('Execute this exact workflow?', 'The displayed source may spawn tasks and read bounded workspace files. Successful stages will be journaled for replay.');
          } : undefined,
          validateTask: async task => { await assertChildTask(task, { approve: ctx.hasUI ? request => ctx.ui.confirm('Approve workflow child extensions', request) : undefined }, ctx.sessionManager.getSessionId()); },
          approveReplay: ctx.hasUI ? stages => ctx.ui.confirm('Replay previously successful stages?', `These stages will NOT run again: ${stages.join(', ')}. Approve only if their outputs and side effects remain valid in the current workspace.`) : async () => false,
          authorizeRead: async path => {
            const decision = await checkAction({ tool: 'read', input: { path }, cwd, provenance: 'workflow readFile' }, {}, ctx.sessionManager.getSessionId());
            if (!decision.allow) throw new Error(decision.reason);
          },
          spawn: async (task, taskSignal) => {
            taskSignal.throwIfAborted();
            const handle = await registry.spawn(task);
            const cancel = () => registry.cancel(handle.id);
            taskSignal.addEventListener('abort', cancel, { once: true });
            if (taskSignal.aborted) cancel();
            try {
              const value = await handle.done;
              if (value.status !== 'succeeded') throw new Error(`Subagent ${value.status}: ${value.error ?? value.stderr}`);
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
        workflows.delete(controller);
        signal?.removeEventListener('abort', abort);
      }
    },
  });
  pi.registerCommand('subagents', {
    description: 'Show background agents or cancel one: /subagents [cancel ID]', handler: async (args, ctx) => {
      context = ctx;
      const [command, id] = args.trim().split(/\s+/);
      if (command === 'cancel' && id) ctx.ui.notify(registry.cancel(id) ? 'Cancellation requested' : 'No active task with that ID', 'info');
      else ctx.ui.notify(JSON.stringify(registry.list().map(({ id, status, usage }) => ({ id, status, usage }))), 'info');
    },
  });
}
