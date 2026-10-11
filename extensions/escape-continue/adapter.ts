import { InteractiveMode, type AgentSession, type CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type Message = ReturnType<AgentSession['agent']['peekQueuedMessages']>[number];
type Host = { session: AgentSession; defaultEditor: CustomEditor };
type Handoff = { cancel(): void; restoreAtContext(): void };
type Registration = { ctx: ExtensionContext; pending?: Handoff; warned: boolean };
type Adapter = { active: WeakMap<ExtensionContext['sessionManager'], Registration>; supported: boolean };
type Queue = { messages: Message[] };
type QueueLayout = {
  agent: { steeringQueue: Queue; followUpQueue: Queue };
  display: { _steeringMessages: string[]; _followUpMessages: string[]; _emitQueueUpdate(): void };
};
const installed = Symbol.for('pi-interactive:escape-continue-adapter');
const wrapped = Symbol.for('pi-interactive:escape-continue-handler');
type Prototype = { bindCurrentSessionExtensions(this: Host): Promise<void>; [installed]?: Adapter };
class CancelledHandoff extends Error {}

// Pi's extension context exposes neither prepared queue contents nor queue removal (tested on 0.99.1).
function queueLayout(session: AgentSession): QueueLayout | undefined {
  const agent = session.agent as unknown as QueueLayout['agent'];
  const display = session as unknown as QueueLayout['display'];
  if (!Array.isArray(agent.steeringQueue?.messages) || !Array.isArray(agent.followUpQueue?.messages) ||
      !Array.isArray(display._steeringMessages) || !Array.isArray(display._followUpMessages) ||
      typeof display._emitQueueUpdate !== 'function') return;
  return { agent, display };
}

function warn(registration: Registration): void {
  if (registration.warned) return;
  registration.warned = true;
  registration.ctx.ui.notify('Escape Continue: unsupported Pi internals; using normal Escape behavior.', 'warning');
}

function attach(host: Host, state: Adapter): void {
  const original = host.defaultEditor.onEscape;
  if (!original || (original as unknown as { [wrapped]?: boolean })[wrapped]) return;
  const handler = () => {
    const session = host.session;
    const registration = state.active.get(session.sessionManager);
    if (registration?.pending) return registration.pending.cancel();
    if (!registration || !session.isStreaming || session.isCompacting) return original();
    const layout = queueLayout(session);
    if (!layout) { warn(registration); return original(); }
    const steering = [...layout.agent.steeringQueue.messages], followUp = [...layout.agent.followUpQueue.messages];
    const selected = [...steering, ...followUp].find(message => message.role === 'user');
    if (!selected || selected.role !== 'user') return original();
    session.clearQueue();
    let delivered = false, restored = false, cancelled = false, starting = false;
    const current = () => host.session === session && state.active.get(session.sessionManager) === registration;
    const release = () => { if (registration.pending === handoff) registration.pending = undefined; };
    const restore = () => {
      if (restored) return;
      restored = true;
      const restoreQueue = (messages: Message[], queue: Queue, texts: string[]) => {
        const remaining = messages.filter(message => !delivered || message !== selected);
        queue.messages.unshift(...remaining);
        texts.unshift(...remaining.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('')));
      };
      restoreQueue(steering, layout.agent.steeringQueue, layout.display._steeringMessages);
      restoreQueue(followUp, layout.agent.followUpQueue, layout.display._followUpMessages);
      layout.display._emitQueueUpdate();
    };
    const handoff: Handoff = {
      cancel() { cancelled = true; },
      restoreAtContext() {
        if (!delivered) return;
        release();
        restore();
      },
    };
    registration.pending = handoff;
    const resume = async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        await session.abort();
        if (cancelled || !current()) throw new CancelledHandoff();
        if (!session.isIdle) throw new Error('Another prompt started during cancellation');
        unsubscribe = session.subscribe(event => {
          if (starting && event.type === 'message_start' && event.message.role === 'user') delivered = true;
        });
        const content = selected.content;
        const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        const images = typeof content === 'string' ? undefined : content.filter(part => part.type === 'image');
        await session.prompt(text, {
          images, expandPromptTemplates: false, source: 'extension',
          preflightResult: disposition => {
            if (disposition !== 'started') return;
            if (cancelled || !current()) throw new CancelledHandoff();
            if (!session.isIdle) throw new Error('Another prompt started during preflight');
            starting = true;
          },
        });
        if (!delivered && current()) registration.ctx.ui.notify('Escape Continue did not start; queued messages and attachments kept waiting.', 'info');
      } catch (error) {
        if (current()) registration.ctx.ui.notify(error instanceof CancelledHandoff
          ? 'Escape Continue stopped; queued messages and attachments kept waiting.'
          : `Escape Continue: ${String(error)}; queued messages and attachments kept waiting.`, error instanceof CancelledHandoff ? 'info' : 'error');
      } finally {
        unsubscribe?.();
        restore();
        release();
      }
    };
    void resume();
  };
  Object.defineProperty(handler, wrapped, { value: true });
  host.defaultEditor.onEscape = handler;
}

export function install(): Adapter {
  const prototype = InteractiveMode.prototype as unknown as Prototype;
  if (prototype[installed]) return prototype[installed];
  const bind = prototype.bindCurrentSessionExtensions;
  const state: Adapter = { active: new WeakMap(), supported: typeof bind === 'function' };
  if (state.supported) prototype.bindCurrentSessionExtensions = async function () {
    await bind.call(this);
    attach(this, state);
  };
  Object.defineProperty(prototype, installed, { value: state });
  return state;
}

export function enable(ctx: ExtensionContext): void {
  const state = install();
  state.active.get(ctx.sessionManager)?.pending?.cancel();
  const registration: Registration = { ctx, warned: false };
  state.active.set(ctx.sessionManager, registration);
  if (!state.supported) warn(registration);
}

export function restoreAfterPrompt(ctx: ExtensionContext): void {
  install().active.get(ctx.sessionManager)?.pending?.restoreAtContext();
}

export function disable(ctx: ExtensionContext): void {
  const state = install();
  state.active.get(ctx.sessionManager)?.pending?.cancel();
  state.active.delete(ctx.sessionManager);
}
