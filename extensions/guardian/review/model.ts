// Resolves the configured reviewer from Pi's model registry, so any provider Pi supports (Claude, GPT, ...) can review.
import { type Api, type AssistantMessage, type Context, type Model, normalizeContext } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ReviewerModel } from '../config.ts';

export type ReviewerRegistry = Pick<ModelRegistry, 'find' | 'getApiKeyAndHeaders' | 'getProvider'>;

export type ResolvedReviewer =
  | { ok: true; complete: (context: Context, signal: AbortSignal) => Promise<AssistantMessage> }
  | { ok: false; message: string };

export function resolveReviewer(registry: ReviewerRegistry, reviewer: ReviewerModel, sessionId: string): ResolvedReviewer {
  const model = registry.find(reviewer.provider, reviewer.model) as Model<Api> | undefined;
  if (!model) return { ok: false, message: `reviewer model ${reviewer.provider}/${reviewer.model} is not available; set reviewer in Guardian's config.json` };
  return {
    ok: true,
    async complete(context, signal) {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`reviewer model ${reviewer.provider}/${reviewer.model} is not authenticated: ${auth.error}`);
      const provider = registry.getProvider(model.provider);
      if (!provider) throw new Error(`reviewer provider ${model.provider} is not available`);
      return provider.streamSimple({ ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) }, normalizeContext(context), {
        apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal, reasoning: reviewer.reasoning, sessionId,
      }).result();
    },
  };
}
