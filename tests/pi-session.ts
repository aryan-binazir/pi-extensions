import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionRuntime, type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions, type ExtensionFactory, type SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';

type ExtensionBindings = Parameters<AgentSession['bindExtensions']>[0];
type Provider = ReturnType<typeof fauxProvider>;
type Selection = Pick<CreateAgentSessionFromServicesOptions, 'model' | 'thinkingLevel' | 'scopedModels'>;
interface Options {
  extensions?: ExtensionFactory[];
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  responses?: Parameters<Provider['setResponses']>[0];
  cwd?: string;
  sessionStartEvent?: SessionStartEvent;
  sessionManager?: SessionManager | ((cwd: string) => SessionManager);
  configure?: (services: AgentSessionServices, provider: Provider, event?: SessionStartEvent) => Selection | Promise<Selection>;
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
  process.env.CLAUDE_CONFIG_DIR ??= join(root, 'claude');
  let runtime: AgentSessionRuntime | undefined;
  let pending: AgentSession | undefined;
  let provider!: Provider;
  const errors: unknown[] = [];
  try {
    runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      provider = fauxProvider({ provider: 'pi-test', tokensPerSecond: Infinity });
      provider.setResponses(options.responses ?? []);
      modelRuntime.registerNativeProvider(provider.provider);
      const settingsManager = SettingsManager.inMemory(options.settings ?? {});
      const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager,
        resourceLoaderOptions: { extensionFactories: options.extensions, noExtensions: !options.settings?.packages?.length && !options.settings?.extensions?.length,
          noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true } });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      assert.deepEqual(services.diagnostics.filter(diagnostic => diagnostic.type === 'error'), []);
      const selection = options.configure ? await options.configure(services, provider, sessionStartEvent) : { model: provider.getModel() };
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: 'builtin', ...selection });
      pending = result.session;
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionStartEvent: options.sessionStartEvent, sessionManager: typeof options.sessionManager === 'function' ? options.sessionManager(cwd) : options.sessionManager ?? SessionManager.create(cwd, join(root, 'sessions')) });
    pending = undefined;
    const bind = async (session: AgentSession) => {
      const bindings = await options.bind?.(session);
      await session.bindExtensions({ commandContextActions: {
        newSession: options => runtime!.newSession(options), switchSession: (path, options) => runtime!.switchSession(path, options),
        fork: (id, options) => runtime!.fork(id, options), navigateTree: (id, options) => session.navigateTree(id, options),
        waitForIdle: () => session.agent.waitForIdle(), reload: () => session.reload(),
      }, ...bindings, onError: error => { errors.push(error); bindings?.onError?.(error); } });
    };
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    const fixture: PiFixture = {
      runtime, cwd, agentDir,
      get session() { return runtime!.session; }, get runner() { return runtime!.session.extensionRunner; },
      get provider() { return provider; },
    };
    return await run(fixture);
  } finally {
    try {
      const session = runtime?.session ?? pending;
      try { await session?.abort(); }
      finally {
        let disposed = false;
        try {
          if (runtime) { await runtime.dispose(); disposed = true; }
          else await pending?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        } finally { if (!disposed) session?.dispose(); }
      }
    } finally {
      if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
      if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
      await rm(root, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    }
  }
}
