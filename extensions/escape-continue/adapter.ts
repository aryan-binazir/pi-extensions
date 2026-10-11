import { AsyncLocalStorage } from 'node:async_hooks';
import { InteractiveMode, type AgentSession, type CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type Message = ReturnType<AgentSession['agent']['peekQueuedMessages']>[number];
type UserMessage = Extract<Message, { role: 'user' }>;
type Mode = 'steer' | 'followUp';
type Host = { session: AgentSession; defaultEditor?: CustomEditor };
type Handoff = { cancel(): void; capture(mode: Mode, message: Message): void; restoreAtContext(): void };
type Registration = { ctx: ExtensionContext; pending?: Handoff; warned: boolean };
type Checkpoint = { session: AgentSession; check(): void };
type Adapter = {
  active: WeakMap<ExtensionContext['sessionManager'], Registration>;
  checkpoints: AsyncLocalStorage<Checkpoint>;
  supported: boolean;
  attach(host: Host, state: Adapter): void;
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
type Prototype = { bindCurrentSessionExtensions(this: Host): Promise<void>; [installed]?: Adapter };
class CancelledHandoff extends Error {}
class SupersededHandoff extends Error {}

// Pi's extension context exposes neither prepared queue contents nor queue removal.
function queueLayout(session: AgentSession): QueueLayout | undefined {
  const agent = session.agent as unknown as QueueLayout['agent'];
  const display = session as unknown as QueueLayout['display'];
  const preflight = session as unknown as QueueLayout['preflight'];
  if (!Array.isArray(agent.steeringQueue?.messages) || !Array.isArray(agent.followUpQueue?.messages) ||
      !Array.isArray(display._steeringMessages) || !Array.isArray(display._followUpMessages) ||
      typeof display._emitQueueUpdate !== 'function' || typeof preflight._normalizePromptImages !== 'function') return;
  return { agent, display, preflight };
}

function textParts(message: UserMessage): string[] {
  return typeof message.content === 'string' ? [message.content]
    : message.content.filter(part => part.type === 'text').map(part => part.text);
}

function isUser(message: Message): message is UserMessage { return message.role === 'user'; }
function marked(fn: unknown, key: symbol): boolean { return typeof fn === 'function' && (fn as unknown as Record<symbol, boolean>)[key] === true; }

function warn(registration: Registration): void {
  if (registration.warned) return;
  registration.warned = true;
  registration.ctx.ui.notify('Escape Continue: unsupported Pi internals; using normal Escape behavior.', 'warning');
}

function wireSession(session: AgentSession, layout: QueueLayout, state: Adapter): void {
  const normalize = layout.preflight._normalizePromptImages;
  if (!marked(normalize, checkpointed)) {
    // Pi 0.99.1/1.0.2 commits next-turn messages and prompt options after this final async preflight boundary.
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
  const original = host.defaultEditor?.onEscape;
  const registration = state.active.get(host.session.sessionManager);
  if (typeof original !== 'function') { if (registration) warn(registration); return; }
  const layout = queueLayout(host.session);
  if (layout) wireSession(host.session, layout, state);
  else if (registration) warn(registration);
  if (marked(original, wrapped)) return;
  const handler = () => state.interrupt(host, original, state);
  Object.defineProperty(handler, wrapped, { value: true });
  host.defaultEditor!.onEscape = handler;
}

function interrupt(host: Host, original: () => void, state: Adapter): void {
  const session = host.session;
  const registration = state.active.get(session.sessionManager);
  if (registration?.pending) return registration.pending.cancel();
  if (!registration || !session.isStreaming || session.isCompacting) return original();
  const layout = queueLayout(session);
  if (!layout) { warn(registration); return original(); }
  const held = { steer: [...layout.agent.steeringQueue.messages], followUp: [...layout.agent.followUpQueue.messages] };
  const selected = [...held.steer, ...held.followUp].find(isUser);
  if (!selected) return original();
  session.clearQueue();
  let delivered = false, restored = false, cancelled = false, starting = false;
  const current = () => host.session === session && state.active.get(session.sessionManager) === registration;
  const count = () => [...held.steer, ...held.followUp].filter(isUser).length;
  const showHeld = () => { if (current()) registration.ctx.ui.setStatus('escape-continue', `Escape Continue: ${count()} queued held · ${cancelled ? 'stopping' : 'handoff'}`); };
  const release = () => {
    if (registration.pending !== handoff) return;
    registration.pending = undefined;
    if (current()) registration.ctx.ui.setStatus('escape-continue', undefined);
  };
  const restore = () => {
    if (restored) return;
    restored = true;
    const restoreQueue = (messages: Message[], queue: Queue, texts: string[]) => {
      const remaining = messages.filter(message => !delivered || message !== selected);
      queue.messages.unshift(...remaining);
      texts.unshift(...remaining.filter(isUser).map(message => textParts(message).join('')));
    };
    restoreQueue(held.steer, layout.agent.steeringQueue, layout.display._steeringMessages);
    restoreQueue(held.followUp, layout.agent.followUpQueue, layout.display._followUpMessages);
    layout.display._emitQueueUpdate();
  };
  const handoff: Handoff = {
    cancel() {
      cancelled = true;
      showHeld();
      if (current()) registration.ctx.ui.notify('Escape Continue stopped; queued messages and attachments kept waiting.', 'info');
      if (starting && session.isStreaming) void session.abort();
    },
    capture(mode, message) {
      held[mode].push(message);
      const texts = mode === 'steer' ? layout.display._steeringMessages : layout.display._followUpMessages;
      if (isUser(message)) {
        const index = texts.lastIndexOf(textParts(message).join(''));
        if (index >= 0) texts.splice(index, 1);
      }
      layout.display._emitQueueUpdate();
      showHeld();
    },
    restoreAtContext() {
      if (!delivered || cancelled) return;
      release();
      restore();
    },
  };
  registration.pending = handoff;
  showHeld();
  const check = () => {
    if (cancelled || !current()) throw new CancelledHandoff();
    if (!session.isIdle) throw new SupersededHandoff('Another prompt started during the handoff');
  };
  const resume = async () => {
    let unsubscribe: (() => void) | undefined;
    try {
      await session.abort();
      check();
      unsubscribe = session.subscribe(event => {
        if (!starting) return;
        if (event.type === 'agent_start' && cancelled) void session.abort();
        if (event.type === 'message_start' && event.message.role === 'user') delivered = true;
      });
      const images = typeof selected.content === 'string' ? undefined : selected.content.filter(part => part.type === 'image');
      await state.checkpoints.run({ session, check }, () => session.prompt(textParts(selected).join('\n'), {
        images, expandPromptTemplates: false, source: 'extension',
        preflightResult: disposition => { if (disposition === 'started') starting = true; },
      }));
      if (!delivered && current() && !cancelled) registration.ctx.ui.notify('Escape Continue did not start; queued messages and attachments kept waiting.', 'info');
    } catch (error) {
      if (current() && !(error instanceof CancelledHandoff && cancelled)) {
        const stopped = error instanceof CancelledHandoff || error instanceof SupersededHandoff;
        const reason = error instanceof Error ? error.message : String(error);
        registration.ctx.ui.notify(`Escape Continue: ${reason || 'handoff stopped'}; queued messages and attachments kept waiting.`, stopped ? 'info' : 'error');
      }
    } finally {
      unsubscribe?.();
      restore();
      release();
    }
  };
  void resume();
}

export function install(): Adapter {
  const prototype = InteractiveMode.prototype as unknown as Prototype;
  let state = prototype[installed];
  if (!state) {
    const bind = prototype.bindCurrentSessionExtensions;
    state = { active: new WeakMap(), checkpoints: new AsyncLocalStorage(), supported: typeof bind === 'function', attach, interrupt };
    const shared = state;
    if (shared.supported) prototype.bindCurrentSessionExtensions = async function () {
      await bind.call(this);
      shared.attach(this, shared);
    };
    Object.defineProperty(prototype, installed, { value: shared });
  }
  state.attach = attach;
  state.interrupt = interrupt;
  return state;
}

export function enable(ctx: ExtensionContext, state: Adapter): void {
  const previous = state.active.get(ctx.sessionManager);
  previous?.pending?.cancel();
  const registration: Registration = { ctx, warned: previous?.warned ?? false };
  state.active.set(ctx.sessionManager, registration);
  if (!state.supported) warn(registration);
}

export function restoreQueuesAtContext(ctx: ExtensionContext, state: Adapter): void {
  state.active.get(ctx.sessionManager)?.pending?.restoreAtContext();
}

export function disable(ctx: ExtensionContext, state: Adapter): void {
  state.active.get(ctx.sessionManager)?.pending?.cancel();
  state.active.delete(ctx.sessionManager);
  ctx.ui.setStatus('escape-continue', undefined);
}
