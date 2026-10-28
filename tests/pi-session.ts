import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionRuntime, type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions, type ExtensionError, type InlineExtension, type SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';

type ExtensionBindings = Parameters<AgentSession['bindExtensions']>[0];
type Provider = ReturnType<typeof fauxProvider>;
type Selection = Pick<CreateAgentSessionFromServicesOptions, 'model' | 'thinkingLevel' | 'scopedModels'>;
interface Options {
  extensions?: InlineExtension[];
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  responses?: Parameters<Provider['setResponses']>[0];
  cwd?: string;
  sessionStartEvent?: SessionStartEvent;
  sessionManager?: SessionManager | ((cwd: string) => SessionManager);
  configure?: (services: AgentSessionServices & { sessionManager: SessionManager }, provider: Provider) => Selection | Promise<Selection>;
  bind?: (session: AgentSession) => ExtensionBindings | Promise<ExtensionBindings>;
}
export interface PiFixture {
  readonly session: AgentSession;
  readonly provider: Provider;
  readonly runner: AgentSession['extensionRunner'];
  runtime: AgentSessionRuntime;
  cwd: string;
  agentDir: string;
}

export async function withPi<T>(options: Options, run: (fixture: PiFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-test-'));
  const cwd = options.cwd ?? root, agentDir = join(root, 'agent');
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  let runtime: AgentSessionRuntime | undefined;
  let liveSession: AgentSession | undefined;
  const provider = fauxProvider({ provider: 'pi-test', tokensPerSecond: Infinity });
  const errors: unknown[] = [];
  let result!: T;
  const record = (error: ExtensionError) => {
    const failure = Object.assign(new Error(error.error), error);
    if (error.stack) failure.stack = error.stack;
    errors.push(failure);
  };
  try {
    provider.setResponses(options.responses ?? []);
    runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider);
      const settingsManager = SettingsManager.inMemory(options.settings ?? {});
      const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager,
        resourceLoaderOptions: { extensionFactories: options.extensions, noExtensions: !options.settings?.packages?.length && !options.settings?.extensions?.length,
          noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true } });
      const loaded = services.resourceLoader.getExtensions();
      const unboundRunner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, new ModelRegistry(modelRuntime));
      unboundRunner.onError(record);
      try {
        assert.deepEqual(loaded.errors, []);
        assert.deepEqual(services.diagnostics.filter(diagnostic => diagnostic.type === 'error'), []);
        const selection = options.configure ? await options.configure({ ...services, sessionManager }, provider) : { model: provider.getModel() };
        const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: 'builtin', ...selection });
        liveSession = result.session;
        return { ...result, services, diagnostics: services.diagnostics };
      } catch (error) {
        await unboundRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        throw error;
      }
    }, { cwd, agentDir, sessionStartEvent: options.sessionStartEvent, sessionManager: typeof options.sessionManager === 'function' ? options.sessionManager(cwd) : options.sessionManager ?? SessionManager.create(cwd, join(root, 'sessions')) });
    const bind = async (session: AgentSession) => {
      const bindings = await options.bind?.(session);
      await session.bindExtensions({ commandContextActions: {
        newSession: options => runtime!.newSession(options), switchSession: (path, options) => runtime!.switchSession(path, options),
        fork: (id, options) => runtime!.fork(id, options), navigateTree: (id, options) => session.navigateTree(id, options),
        waitForIdle: () => session.waitForIdle(), reload: () => session.reload(),
      }, ...bindings, onError: error => { record(error); bindings?.onError?.(error); } });
    };
    runtime.setBeforeSessionInvalidate(() => { liveSession = undefined; });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    const fixture: PiFixture = {
      runtime, cwd, agentDir,
      get session() { return runtime!.session; }, get runner() { return runtime!.session.extensionRunner; },
      provider,
    };
    result = await run(fixture);
  } catch (error) { errors.unshift(error); }
  finally {
    if (runtime && liveSession) {
      const session = liveSession;
      try { await session.abort(); } catch (error) { errors.push(error); }
      try { await runtime.dispose(); }
      catch (error) { errors.push(error); session.dispose(); }
    }
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Pi test session failed');
  return result;
}
