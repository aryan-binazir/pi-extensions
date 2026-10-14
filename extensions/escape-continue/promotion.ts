import type { AgentSession } from '@earendil-works/pi-coding-agent';

export type Message = ReturnType<AgentSession['agent']['peekQueuedMessages']>[number];
export type UserMessage = Extract<Message, { role: 'user' }>;
export type Mode = 'steer' | 'followUp';
export type HeldQueues = { steer: Message[]; followUp: Message[] };
export type Promotion = { cancel(stopRun?: boolean): void; capture(mode: Mode, message: Message): void; restoreAtContext(): void; takeQueue(): { steering: string[]; followUp: string[] } };
export type SessionPort = {
  queued: HeldQueues;
  clear(): void;
  restore(remaining: HeldQueues): void;
  capture(mode: Mode, message: Message): void;
  abort(): Promise<void>;
  streaming(): boolean;
  prompt(message: UserMessage, check: () => void, events: { started(): void; runStarted(): void; delivered(): void }): Promise<void>;
};
type PromotionUI = {
  current(): boolean;
  notify(message: string, level: 'info' | 'error'): void;
  status(text: string | undefined): void;
  pending(promotion: Promotion): void;
  release(promotion: Promotion): boolean;
};
class CancelledPromotion extends Error {}
export class SupersededPromotion extends Error {}

export function textParts(message: UserMessage): string[] {
  return typeof message.content === 'string' ? [message.content]
    : message.content.filter(part => part.type === 'text').map(part => part.text);
}

export function isUser(message: Message): message is UserMessage { return message.role === 'user'; }

export function startPromotion(port: SessionPort, ui: PromotionUI): Promotion | undefined {
  const held = port.queued;
  const selected = [...held.steer, ...held.followUp].find(isUser);
  if (!selected) return;
  let delivered = false, restored = false, cancelled = false, starting = false;
  const current = ui.current;
  const count = () => [...held.steer, ...held.followUp].filter(isUser).length;
  const showHeld = () => { if (current()) ui.status(`Escape Continue: ${count()} queued held · ${cancelled ? 'stopping' : 'promotion'}`); };
  const release = () => {
    if (!ui.release(promotion)) return;
    if (current()) ui.status(undefined);
  };
  const restore = () => {
    if (restored) return;
    restored = true;
    const remaining = (messages: Message[]) => messages.filter(message => !delivered || message !== selected);
    port.restore({ steer: remaining(held.steer), followUp: remaining(held.followUp) });
  };
  const promotion: Promotion = {
    cancel(stopRun = true) {
      if (cancelled) return;
      cancelled = true;
      showHeld();
      if (current()) ui.notify('Escape Continue stopped; queued messages and attachments kept waiting.', 'info');
      if (stopRun && starting && port.streaming()) void port.abort();
    },
    capture(mode, message) {
      held[mode].push(message);
      port.capture(mode, message);
      showHeld();
    },
    restoreAtContext() {
      if (!delivered || cancelled) return;
      release();
      restore();
    },
    takeQueue() {
      const texts = (messages: Message[]) => messages.filter(isUser).filter(message => !delivered || message !== selected).map(message => textParts(message).join(''));
      const result = { steering: texts(held.steer), followUp: texts(held.followUp) };
      restored = true;
      release();
      if (current()) ui.notify('Escape Continue: held queued text returned to Pi; normal dequeue/abort attachment handling applies.', 'info');
      return result;
    },
  };
  port.clear();
  ui.pending(promotion);
  showHeld();
  const check = () => {
    if (cancelled || !current()) throw new CancelledPromotion();
  };
  const resume = async () => {
    try {
      await port.prompt(selected, check, {
        started() { starting = true; },
        runStarted() { if (starting && cancelled) void port.abort(); },
        delivered() { if (starting) delivered = true; },
      });
      if (!delivered && current() && !cancelled) ui.notify('Escape Continue did not start; queued messages and attachments kept waiting.', 'info');
    } catch (error) {
      if (current() && !(error instanceof CancelledPromotion && cancelled)) {
        const stopped = error instanceof CancelledPromotion || error instanceof SupersededPromotion;
        const reason = error instanceof Error ? error.message : String(error);
        ui.notify(`Escape Continue: ${reason || 'promotion stopped'}; queued messages and attachments kept waiting.`, stopped ? 'info' : 'error');
      }
    } finally {
      restore();
      release();
    }
  };
  void resume();
  return promotion;
}
