export type DesktopAction =
  | { action: 'screenshot'; output?: string }
  | { action: 'accessibility' }
  | { action: 'click'; output: string; x: number; y: number; button?: 'left'|'right'|'middle' }
  | { action: 'type'; text: string }
  | { action: 'scroll'; output: string; dx: number; dy: number };
export interface DesktopResult { [key: string]: unknown; image?: string; mimeType?: 'image/png' }
export interface DesktopBackend { run(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult>; close(): void | Promise<void> }

function validateAction(value: unknown): asserts value is DesktopAction {
  const invalid = () => { throw new Error('Invalid desktop command'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const a = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { screenshot: ['action', 'output'], accessibility: ['action'], click: ['action', 'output', 'x', 'y', 'button'], type: ['action', 'text'], scroll: ['action', 'output', 'dx', 'dy'] };
  const allowed = typeof a.action === 'string' && Object.hasOwn(fields, a.action) ? fields[a.action] : undefined;
  if (!allowed || Object.keys(a).some(key => !allowed.includes(key))) invalid();
  const number = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  if (a.output !== undefined && (typeof a.output !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(a.output))) invalid();
  if ((a.action === 'click' || a.action === 'scroll') && !a.output) invalid();
  if (a.action === 'click' && (!number(a.x, 0, 1) || !number(a.y, 0, 1) || (a.button !== undefined && !['left', 'right', 'middle'].includes(String(a.button))))) invalid();
  if (a.action === 'scroll' && (!number(a.dx, -1000, 1000) || !number(a.dy, -1000, 1000))) invalid();
  if (a.action === 'type' && (typeof a.text !== 'string' || a.text.length > 10000 || a.text.includes('\0'))) invalid();
}

export class DesktopSession {
  private backend?: DesktopBackend;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active?: AbortController;
  constructor(private readonly create: () => DesktopBackend, private readonly timeoutMs = 15_000) {}
  run(action: DesktopAction, signal?: AbortSignal): Promise<DesktopResult> {
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error('Desktop session closed');
      validateAction(action);
      signal?.throwIfAborted();
      const control = new AbortController(); this.active = control;
      const combined = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
      const timer = setTimeout(() => control.abort(new Error('Desktop operation timed out')), this.timeoutMs);
      try { return await this.execute(action, combined); }
      finally { clearTimeout(timer); this.active = undefined; }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async execute(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult> {
    const inspect = action.action === 'screenshot' || action.action === 'accessibility';
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      this.backend ??= this.create();
      const backend = this.backend;
      let abort: (() => void) | undefined;
      try {
        return await Promise.race([backend.run(action, signal), new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? new Error('Desktop operation aborted'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })]);
      } catch (error) {
        this.backend = undefined;
        let closeFailure: unknown;
        try { await backend.close(); } catch (failure) { closeFailure = failure; }
        if (!inspect) throw new Error(`Desktop mutation failed or was cancelled; outcome may be partial or unknown. Inspect before deciding whether to repeat. ${error instanceof Error ? error.message.slice(0, 500) : 'Transport failure'}`, { cause: error });
        if (attempt === 0 && !signal.aborted) continue;
        throw closeFailure === undefined ? error : new Error(closeFailure instanceof Error ? closeFailure.message : 'Desktop transport close failed', { cause: error });
      } finally { if (abort) signal.removeEventListener('abort', abort); }
    }
  }
  async close() { this.closed = true; this.active?.abort(new Error('Desktop session shutdown')); await this.queue; await this.backend?.close(); this.backend = undefined; }
}
