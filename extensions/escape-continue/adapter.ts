import { AsyncLocalStorage } from 'node:async_hooks';
import { AssistantMessageComponent, InteractiveMode, type AgentSession, type AgentSessionEvent, type CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, type Component } from '@earendil-works/pi-tui';
import { isUser, startPromotion, SupersededPromotion, textParts, type Message, type Promotion, type SessionPort } from './promotion.ts';
import { installEditorInput, registerMainEditorBinding } from '../editor-input.ts';

type Host = { session: AgentSession; defaultEditor?: CustomEditor; editor?: CustomEditor; ui?: { getFocusedComponent(): Component | null; requestRender(): void } };
type Registration = { ctx: ExtensionContext; pending?: Promotion; warned: boolean; input?: { editor: CustomEditor; reset(): void } };
type Checkpoint = { session: AgentSession; check(): void };
type Adapter = {
  active: WeakMap<ExtensionContext['sessionManager'], Registration>;
  hosts: WeakMap<ExtensionContext['sessionManager'], Host>;
  checkpoints: AsyncLocalStorage<Checkpoint>;
  rawAborts: WeakMap<AgentSession, () => Promise<void>>;
  quietAborts: WeakMap<AgentSession, object>;
  quietMessages: WeakSet<object>;
  prompts: WeakMap<AgentSession, Set<{ interrupted: boolean }>>;
  warnedSessions: WeakSet<ExtensionContext['sessionManager']>;
  supported: boolean;
  attach(host: Host, state: Adapter): void;
  decorate(host: Host, state: Adapter): void;
  interrupt(host: Host, original: () => void, state: Adapter): void;
};
type Queue = { messages: Message[] };
type QueueLayout = {
  agent: { steeringQueue: Queue; followUpQueue: Queue };
  display: { _steeringMessages: string[]; _followUpMessages: string[]; _emitQueueUpdate(): void };
  preflight: { _normalizePromptImages(images: unknown): Promise<unknown> };
};
const installed = Symbol.for('pi-interactive:escape-continue-adapter');
const wrapped = Symbol.for('pi-interactive:escape-continue-handler');
const checkpointed = Symbol.for('pi-interactive:escape-continue-preflight');
const intercepted = Symbol.for('pi-interactive:escape-continue-queue');
type Prototype = { handleEvent(this: Host, event: AgentSessionEvent): Promise<void>; bindCurrentSessionExtensions(this: Host): Promise<void>; setCustomEditorComponent(this: Host, factory: unknown): void; shutdown(this: Host, options?: { fromSignal?: boolean }): Promise<void>; handleReloadCommand(this: Host): Promise<void>; [installed]?: Adapter };

// Pi's extension context exposes neither prepared queue contents nor queue removal.
function queueLayout(session: AgentSession): QueueLayout | undefined {
  const agent = session.agent as unknown as QueueLayout['agent'];
  const display = session as unknown as QueueLayout['display'];
  const preflight = session as unknown as QueueLayout['preflight'];
  if (!Array.isArray(agent.steeringQueue?.messages) || !Array.isArray(agent.followUpQueue?.messages) ||
      !Array.isArray(display._steeringMessages) || !Array.isArray(display._followUpMessages) ||
      typeof display._emitQueueUpdate !== 'function' || typeof preflight._normalizePromptImages !== 'function' || typeof session.reload !== 'function') return;
  return { agent, display, preflight };
}

function marked(fn: unknown, key: symbol): boolean { return typeof fn === 'function' && (fn as unknown as Record<symbol, boolean>)[key] === true; }

function warn(registration: Registration, state: Adapter): void {
  if (registration.warned || state.warnedSessions.has(registration.ctx.sessionManager)) return;
  registration.warned = true;
  state.warnedSessions.add(registration.ctx.sessionManager);
  registration.ctx.ui.notify('Escape Continue: unsupported Pi internals; using normal Escape behavior.', 'warning');
}

function abortRun(session: AgentSession, state: Adapter): Promise<void> {
  return state.rawAborts.get(session)?.() ?? session.abort();
}

async function abortForPromotion(session: AgentSession, state: Adapter): Promise<void> {
  const scope = {};
  state.quietAborts.set(session, scope);
  for (const prompt of state.prompts.get(session) ?? []) prompt.interrupted = true;
  try { await abortRun(session, state); }
  finally { if (state.quietAborts.get(session) === scope) state.quietAborts.delete(session); }
}

function wireSession(session: AgentSession, layout: QueueLayout, state: Adapter): void {
  if (!marked(session.prompt, intercepted)) {
    const prompt = session.prompt.bind(session);
    const active = new Set<{ interrupted: boolean }>();
    state.prompts.set(session, active);
    const guarded: AgentSession['prompt'] = async (...args) => {
      const call = { interrupted: false };
      active.add(call);
      try { await prompt(...args); }
      catch (error) {
        if (!call.interrupted || !(error instanceof Error) || error.name !== 'AbortError') throw error;
      } finally { active.delete(call); }
    };
    Object.defineProperty(guarded, intercepted, { value: true });
    session.prompt = guarded;
  }
  if (!state.rawAborts.has(session)) {
    const abort = session.abort.bind(session);
    const clear = session.clearQueue.bind(session);
    state.rawAborts.set(session, abort);
    session.abort = () => {
      state.active.get(session.sessionManager)?.pending?.cancel(false);
      return abort();
    };
    session.clearQueue = () => {
      const pending = state.active.get(session.sessionManager)?.pending;
      pending?.cancel(false);
      const held = pending?.takeQueue();
      const queued = clear();
      return held ? { steering: [...held.steering, ...queued.steering], followUp: [...held.followUp, ...queued.followUp] } : queued;
    };
  }
  if (!marked(session.reload, intercepted)) {
    const reload = session.reload.bind(session);
    const guarded: AgentSession['reload'] = (...args) => {
      state.active.get(session.sessionManager)?.pending?.cancel();
      state.active.get(session.sessionManager)?.input?.reset();
      return reload(...args);
    };
    Object.defineProperty(guarded, intercepted, { value: true });
    session.reload = guarded;
  }
  const normalize = layout.preflight._normalizePromptImages;
  if (!marked(normalize, checkpointed)) {
    // Pi commits options and next-turn messages after image preparation, including 0.99 and 1.2.
    const guarded = async (images: unknown) => {
      const scope = state.checkpoints.getStore();
      if (scope?.session === session) scope.check();
      const result = await normalize.call(session, images);
      if (scope?.session === session) scope.check();
      return result;
    };
    Object.defineProperty(guarded, checkpointed, { value: true });
    layout.preflight._normalizePromptImages = guarded;
  }
  for (const mode of ['steer', 'followUp'] as const) {
    const original = session.agent[mode];
    if (marked(original, intercepted)) continue;
    const enqueue = (message: Message) => {
      const pending = state.active.get(session.sessionManager)?.pending;
      if (pending) pending.capture(mode, message);
      else original.call(session.agent, message);
    };
    Object.defineProperty(enqueue, intercepted, { value: true });
    session.agent[mode] = enqueue;
  }
}

function attach(host: Host, state: Adapter): void {
  state.hosts.set(host.session.sessionManager, host);
  const original = host.defaultEditor?.onEscape;
  const registration = state.active.get(host.session.sessionManager);
  if (!state.supported || typeof original !== 'function') { if (registration) warn(registration, state); return; }
  const layout = queueLayout(host.session);
  if (layout) wireSession(host.session, layout, state);
  else if (registration) warn(registration, state);
  if (!marked(original, wrapped)) {
    const handler = () => state.interrupt(host, original, state);
    Object.defineProperty(handler, wrapped, { value: true });
    host.defaultEditor!.onEscape = handler;
  }
  state.decorate(host, state);
}

function decorate(host: Host, state: Adapter): void {
  const editor = host.editor;
  const session = host.session;
  const registration = state.active.get(session.sessionManager);
  if (!registration || !editor || typeof editor.handleInput !== 'function' || !host.ui?.getFocusedComponent) return;
  if (registration.input?.editor === editor) return;
  registration.input?.reset();
  const unregister = registerMainEditorBinding(registration.ctx, {
    id: 'escape-continue', priority: 200,
    create(editor) {
      const current = () => host.session === session && state.active.get(session.sessionManager) === registration;
      registration.input = { editor, reset: () => unregister() };
      return {
        key(data) {
          if (!current()) return false;
          if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+enter')) state.attach(host, state);
          if (!matchesKey(data, 'ctrl+enter')) return false;
          if (registration.pending || session.isStreaming || session.isCompacting || session.isRetrying || session.isBashRunning)
            (editor.onEscape ?? editor.actionHandlers?.get('app.interrupt'))?.();
          return true;
        },
      };
    },
  });
}

function sessionPort(session: AgentSession, state: Adapter): SessionPort | undefined {
  const layout = queueLayout(session);
  if (!layout) return;
  return {
    queued: { steer: [...layout.agent.steeringQueue.messages], followUp: [...layout.agent.followUpQueue.messages] },
    clear: () => { session.clearQueue(); },
    restore(remaining) {
      for (const mode of ['steer', 'followUp'] as const) {
        const queue = mode === 'steer' ? layout.agent.steeringQueue : layout.agent.followUpQueue;
        const texts = mode === 'steer' ? layout.display._steeringMessages : layout.display._followUpMessages;
        queue.messages.unshift(...remaining[mode]);
        texts.unshift(...remaining[mode].filter(isUser).map(message => textParts(message).join('')));
      }
      layout.display._emitQueueUpdate();
    },
    capture(mode, message) {
      const texts = mode === 'steer' ? layout.display._steeringMessages : layout.display._followUpMessages;
      if (isUser(message)) {
        const index = texts.lastIndexOf(textParts(message).join(''));
        if (index >= 0) texts.splice(index, 1);
      }
      layout.display._emitQueueUpdate();
    },
    abort: () => abortRun(session, state),
    streaming: () => session.isStreaming,
    async prompt(message, check, events) {
      await abortForPromotion(session, state);
      check();
      // Pi 0.99 supplies activity flags; 7229077 removed reliance on a host's idle getter.
      if (session.isStreaming || session.isCompacting) throw new SupersededPromotion('Another prompt started during the promotion');
      const unsubscribe = session.subscribe(event => {
        // Pi 0.87 reports boolean preflight results; scoped agent_start still proves ownership.
        if (event.type === 'agent_start' && state.checkpoints.getStore()?.check === check) events.started();
        if (event.type === 'agent_start') events.runStarted();
        if (event.type === 'message_start' && event.message.role === 'user') events.delivered();
      });
      try {
        const images = typeof message.content === 'string' ? undefined : message.content.filter(part => part.type === 'image');
        // Pi 1.2 sets streaming before image preparation; checkpoints check cancellation and identity.
        await state.checkpoints.run({ session, check }, () => session.prompt(textParts(message).join('\n'), {
          images, expandPromptTemplates: false, source: 'extension',
          preflightResult: disposition => { if (disposition === 'started') events.started(); },
        }));
      } finally { unsubscribe(); }
    },
  };
}

function interrupt(host: Host, original: () => void, state: Adapter): void {
  const session = host.session;
  const registration = state.active.get(session.sessionManager);
  if (registration?.pending) return registration.pending.cancel();
  if (!state.supported || !registration || !session.isStreaming || session.isCompacting) return original();
  const port = sessionPort(session, state);
  if (!port) { warn(registration, state); return original(); }
  const promotion = startPromotion(port, {
    current: () => host.session === session && state.active.get(session.sessionManager) === registration,
    notify: (message, level) => registration.ctx.ui.notify(message, level),
    status: text => registration.ctx.ui.setStatus('escape-continue', text),
    pending: promotion => { registration.pending = promotion; },
    release(promotion) {
      if (registration.pending !== promotion) return false;
      registration.pending = undefined;
      return true;
    },
  });
  if (!promotion) original();
}

export function install(): Adapter {
  installEditorInput();
  const prototype = InteractiveMode.prototype as unknown as Prototype;
  let state = prototype[installed];
  if (!state) {
    const bind = prototype.bindCurrentSessionExtensions;
    state = { active: new WeakMap(), hosts: new WeakMap(), checkpoints: new AsyncLocalStorage(), rawAborts: new WeakMap(), quietAborts: new WeakMap(), quietMessages: new WeakSet(), prompts: new WeakMap(), warnedSessions: new WeakSet(), supported: typeof bind === 'function', attach, decorate, interrupt };
    const shared = state;
    if (shared.supported) prototype.bindCurrentSessionExtensions = async function () {
      await bind.call(this);
      shared.attach(this, shared);
    };
    Object.defineProperty(prototype, installed, { value: shared });
  }
  state.quietAborts ??= new WeakMap();
  state.quietMessages ??= new WeakSet();
  state.prompts ??= new WeakMap();
  const handleEvent = prototype.handleEvent;
  const updateContent = AssistantMessageComponent.prototype.updateContent;
  if (typeof handleEvent !== 'function' || typeof updateContent !== 'function') state.supported = false;
  else {
    const shared = state;
    if (!marked(handleEvent, wrapped)) {
      const handle = function (this: Host, event: AgentSessionEvent) {
        if (event.type === 'agent_start' || event.type === 'agent_end') shared.quietAborts.delete(this.session);
        if ((event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant' &&
            event.message.stopReason === 'aborted' && shared.quietAborts.has(this.session))
          shared.quietMessages.add(event.message);
        return handleEvent.call(this, event);
      };
      Object.defineProperty(handle, wrapped, { value: true });
      prototype.handleEvent = handle;
    }
    if (!marked(updateContent, wrapped)) {
      // Pi has no assistant-notice renderer hook; change only the renderer's view, not session messages.
      const update: AssistantMessageComponent['updateContent'] = function (this: AssistantMessageComponent, message, streaming) {
        return updateContent.call(this, shared.quietMessages.has(message) && message.stopReason === 'aborted'
          ? { ...message, stopReason: 'stop', errorMessage: undefined } : message, streaming);
      };
      Object.defineProperty(update, wrapped, { value: true });
      AssistantMessageComponent.prototype.updateContent = update;
    }
  }
  state.rawAborts ??= new WeakMap();
  state.warnedSessions ??= new WeakSet();
  state.hosts ??= new WeakMap();
  const shutdown = prototype.shutdown;
  if (typeof shutdown !== 'function') state.supported = false;
  else if (!marked(shutdown, wrapped)) {
    const shared = state;
    const stop = function (this: Host, options?: { fromSignal?: boolean }) {
      shared.active.get(this.session.sessionManager)?.pending?.cancel();
      shared.active.get(this.session.sessionManager)?.input?.reset();
      return shutdown.call(this, options);
    };
    Object.defineProperty(stop, wrapped, { value: true });
    prototype.shutdown = stop;
  }
  const reload = prototype.handleReloadCommand;
  if (typeof reload !== 'function') state.supported = false;
  else if (!marked(reload, wrapped)) {
    const shared = state;
    const guarded = function (this: Host) {
      if (!this.session.isStreaming && !this.session.isCompacting) {
        shared.active.get(this.session.sessionManager)?.pending?.cancel();
        shared.active.get(this.session.sessionManager)?.input?.reset();
      }
      return reload.call(this);
    };
    Object.defineProperty(guarded, wrapped, { value: true });
    prototype.handleReloadCommand = guarded;
  }
  state.attach = attach;
  state.decorate = decorate;
  state.interrupt = interrupt;
  return state;
}

export function enable(ctx: ExtensionContext, state: Adapter): void {
  const previous = state.active.get(ctx.sessionManager);
  previous?.pending?.cancel();
  previous?.input?.reset();
  const registration: Registration = { ctx, warned: previous?.warned ?? false };
  state.active.set(ctx.sessionManager, registration);
  const host = state.hosts.get(ctx.sessionManager);
  if (host) state.attach(host, state);
  if (!state.supported) warn(registration, state);
}

export function cancelForInput(ctx: ExtensionContext, state: Adapter): void {
  const owned = state.checkpoints.getStore()?.session.sessionManager === ctx.sessionManager;
  if (ctx.isIdle() && !owned) state.active.get(ctx.sessionManager)?.pending?.cancel(false);
}

export function restoreQueuesAtContext(ctx: ExtensionContext, state: Adapter): void {
  state.active.get(ctx.sessionManager)?.pending?.restoreAtContext();
}

export function disable(ctx: ExtensionContext, state: Adapter): void {
  state.active.get(ctx.sessionManager)?.pending?.cancel();
  state.active.get(ctx.sessionManager)?.input?.reset();
  state.active.delete(ctx.sessionManager);
  ctx.ui.setStatus('escape-continue', undefined);
}
