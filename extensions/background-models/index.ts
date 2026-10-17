import type { Api, Context, Model, ModelsApiStreamOptions } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent';

const installed = Symbol.for('pi-interactive:background-models');
type Originals = Pick<ModelRegistry, 'stream' | 'complete'>;
type Registry = ModelRegistry & { [installed]?: Originals };

function requestOptions<T extends Api>(model: Model<T>, options?: ModelsApiStreamOptions<T>): ModelsApiStreamOptions<T> | undefined {
  if (model.api !== 'openai-codex-responses' && model.id !== 'gpt-6-luna') return options;
  const result: Record<string, unknown> = { ...options };
  if (model.api === 'openai-codex-responses') delete result.temperature;
  if (model.id === 'gpt-6-luna' && result.reasoningEffort === undefined) result.reasoningEffort = 'medium';
  return result as ModelsApiStreamOptions<T>;
}

export default function backgroundModels(pi: ExtensionAPI): void {
  let restore: (() => void) | undefined;
  pi.on('session_start', (_event, ctx) => {
    restore?.();
    const registry = ctx.modelRegistry as Registry;
    const original = registry[installed] ??= {
      stream: registry.stream.bind(registry),
      complete: registry.complete.bind(registry),
    };
    const stream: ModelRegistry['stream'] = <T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>) =>
      original.stream(model, context, requestOptions(model, options));
    const complete: ModelRegistry['complete'] = <T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>) =>
      original.complete(model, context, requestOptions(model, options));
    registry.stream = stream;
    registry.complete = complete;
    restore = () => {
      if (registry.stream === stream) registry.stream = original.stream;
      if (registry.complete === complete) registry.complete = original.complete;
      if (registry.stream === original.stream && registry.complete === original.complete) delete registry[installed];
    };
  });
  pi.on('session_shutdown', () => {
    restore?.();
    restore = undefined;
  });
}
