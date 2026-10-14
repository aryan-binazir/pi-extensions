import { normalizeContext, type Api, type AssistantMessageEvent, type UserMessage, type Model, type ThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

export interface SideCompletionRequest {
  registry: Pick<ModelRegistry, 'getApiKeyAndHeaders' | 'getProvider'>;
  model: Model<Api>;
  systemPrompt: string;
  messages: UserMessage[];
  limits: {characters: number; tokens: number};
  signal: AbortSignal;
  textSource?: 'final' | 'deltas';
  reasoning?: ThinkingLevel;
  sessionId?: string;
  onStart?: () => void;
  onText?: (text: string) => void;
}
export type SideCompletionResult = {ok: true; text: string} | {ok: false; text: string} & (
  | {kind: 'auth' | 'provider' | 'aborted'; error: unknown}
  | {kind: 'provider-unavailable'}
  | {kind: 'limit'}
  | {kind: 'tool-use'}
  | {kind: 'incomplete'}
  | {kind: 'empty'}
);

async function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once: true});
  });
  try { return await Promise.race([value, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function sideCompletion(request: SideCompletionRequest): Promise<SideCompletionResult> {
  const {registry, model, systemPrompt, messages, limits, signal} = request;
  const controller = new AbortController();
  const transportSignal = AbortSignal.any([signal, controller.signal]);
  let text = '';
  let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
  try {
    signal.throwIfAborted();
    const auth = await abortable(registry.getApiKeyAndHeaders(model), signal);
    if (!auth.ok) return {ok: false, kind: 'auth', text, error: new Error(auth.error)};
    const provider = registry.getProvider(model.provider);
    if (!provider) return {ok: false, kind: 'provider-unavailable', text};
    signal.throwIfAborted();
    const stream = provider.streamSimple({...model, ...(auth.baseUrl ? {baseUrl: auth.baseUrl} : {})},
      normalizeContext({systemPrompt, messages, tools: []}), {
        apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: transportSignal,
        maxTokens: limits.tokens,
        // Bridge 0.9.2 routes "none" through its verbatim summarizer path.
        cacheRetention: model.provider === 'claude-bridge' ? 'short' : 'none',
        ...(request.reasoning ? {reasoning: request.reasoning} : {}),
        ...(request.sessionId ? {sessionId: request.sessionId} : {}),
      });
    request.onStart?.();
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await abortable(iterator.next(), signal);
      signal.throwIfAborted();
      if (next.done) return {ok: false, kind: 'incomplete', text};
      const event = next.value;
      if (event.type === 'text_delta') {
        text += event.delta.slice(0, limits.characters - text.length);
        request.onText?.(text);
        if (text.length >= limits.characters) {
          controller.abort();
          return {ok: false, kind: 'limit', text};
        }
      }
      if (event.type === 'error') return {ok: false, kind: 'provider', text, error: new Error(event.error.errorMessage || 'Provider request failed')};
      if (event.type === 'done') {
        if (request.textSource !== 'deltas') {
          text = '';
          for (const block of event.message.content) {
            if (block.type === 'text') text += block.text.slice(0, limits.characters - text.length);
            if (text.length >= limits.characters) break;
          }
        }
        if (event.reason === 'toolUse') return {ok: false, kind: 'tool-use', text};
        if (text.length >= limits.characters) return {ok: false, kind: 'limit', text};
        if (!text.trim()) return {ok: false, kind: 'empty', text};
        return {ok: true, text};
      }
    }
  } catch (error) {
    return {ok: false, kind: signal.aborted ? 'aborted' : 'provider', text, error};
  } finally {
    void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
  }
}
