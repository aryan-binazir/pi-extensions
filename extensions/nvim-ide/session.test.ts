import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import nvimIde from './index.ts';
import { fakeIde, token, until } from './test-support.ts';

test('real Pi requests persist the included editor snapshot, not unsubmitted notifications', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-editor-snapshot-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  let initialized = false;
  const ide = fakeIde(socket => socket.on('message', raw => {
    if (JSON.parse(raw.toString()).method === 'notifications/initialized') initialized = true;
  }));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await once(ide.server, 'listening');
    await mkdir(join(cwd, 'ide'));
    await writeFile(join(cwd, 'ide', `${ide.port()}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: [cwd], ideName: 'Neovim', authToken: token }));
    process.env.CLAUDE_CONFIG_DIR = cwd;
    const agentDir = join(cwd, 'agent');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [nvimIde], noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const provider = fauxProvider({ provider: 'editor-request-snapshots', tokensPerSecond: Infinity });
    const requests: string[] = [];
    provider.setResponses([context => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage('Acknowledged'); }]);
    runtime.registerNativeProvider(provider.provider);
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime, sessionManager: manager, model: provider.getModel(), noTools: 'builtin' }));
    await session.bindExtensions({});
    await until(() => initialized);
    const errors: unknown[] = [];
    session.extensionRunner!.onError(error => errors.push(error));
    const select = async (text: string) => {
      ide.broadcast('selection_changed', { filePath: join(cwd, 'source.ts'), text, selection: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length }, isEmpty: false } });
      const runner = session!.extensionRunner!;
      await session!.getToolDefinition('nvim_context')!.execute('barrier', {}, undefined, undefined, runner.createToolContext('barrier', undefined));
    };
    await select('NEVER_SUBMITTED');
    assert.ok(!JSON.stringify(manager.getBranch()).includes('NEVER_SUBMITTED'));
    await select('INCLUDED_IN_REQUEST');
    await session.prompt('Use the current selection');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes('INCLUDED_IN_REQUEST'));
    assert.ok(!requests[0].includes('NEVER_SUBMITTED'));
    await select('AFTER_REQUEST_UNSUBMITTED');
    const persisted = JSON.stringify(SessionManager.open(manager.getSessionFile()!).getBranch());
    assert.ok(persisted.includes('INCLUDED_IN_REQUEST'));
    assert.ok(!persisted.includes('NEVER_SUBMITTED'));
    assert.ok(!persisted.includes('AFTER_REQUEST_UNSUBMITTED'));
    assert.deepEqual(errors, []);
  } finally {
    await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    await ide.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
