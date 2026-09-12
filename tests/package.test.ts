import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, ModelRuntime, SessionManager, DefaultPackageManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = resolve(import.meta.dirname, '..');
const intended = ['questionnaire', 'memory', 'todo', 'effort', 'btw', 'vi-mode', 'prompt-stash', 'subagents', 'worktree', 'mcp-client', 'computer-use', 'fast-mode', 'auto-caffeinate'];

test('Pi package discovers exactly thirteen entrypoints and independently loads each', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-package-test-'));
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi.extensions, intended.map(name => `./extensions/${name}/index.ts`));
    const settingsManager = SettingsManager.inMemory({ packages: [root] });
    const manager = new DefaultPackageManager({ cwd: temp, agentDir: join(temp, 'agent'), settingsManager });
    const paths = await manager.resolve();
    assert.deepEqual(paths.extensions.map(entry => entry.path).sort(), intended.map(name => join(root, 'extensions', name, 'index.ts')).sort());
    for (const entry of paths.extensions) {
      const loader = new DefaultResourceLoader({cwd: temp, agentDir: join(temp, 'agent'), settingsManager: SettingsManager.inMemory({packages: [{source: root, extensions: [entry.path.slice(root.length + 1)]}]}), noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true});
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, [], entry.path);
      assert.equal(loaded.extensions.length, 1, entry.path);
      const extension = loaded.extensions[0];
      const feature = entry.path.split('/').at(-2)!;
      const expected: Record<string, { tools: string[]; commands: string[]; shortcuts: string[] }> = {
        questionnaire: {tools: ['questionnaire'], commands: [], shortcuts: []},
        memory: {tools: ['memory'], commands: [], shortcuts: []},
        todo: {tools: ['todo_write'], commands: [], shortcuts: []},
        effort: {tools: [], commands: ['effort'], shortcuts: []},
        btw: {tools: [], commands: ['btw', 'side'], shortcuts: []},
        'vi-mode': {tools: [], commands: [], shortcuts: []},
        'prompt-stash': {tools: [], commands: [], shortcuts: ['ctrl+shift+s']},
        subagents: {tools: ['subagent', 'subagent_cancel', 'subagent_status', 'workflow'], commands: ['subagents'], shortcuts: []},
        worktree: {tools: ['bash'], commands: ['worktree'], shortcuts: []},
        'mcp-client': {tools: ['mcp'], commands: ['mcp-auth', 'mcp-connect'], shortcuts: []},
        'computer-use': {tools: ['computer_accessibility', 'computer_click', 'computer_screenshot', 'computer_scroll', 'computer_type'], commands: [], shortcuts: []},
        'fast-mode': {tools: [], commands: ['fast'], shortcuts: []},
        'auto-caffeinate': {tools: [], commands: [], shortcuts: []},
      };
      assert.deepEqual([...extension.tools.keys()].sort(), expected[feature].tools, feature);
      assert.deepEqual([...extension.commands.keys()].sort(), expected[feature].commands, feature);
      assert.deepEqual([...extension.shortcuts.keys()].sort(), expected[feature].shortcuts, feature);
      if (feature === 'auto-caffeinate') for (const event of ['agent_start', 'agent_settled', 'session_shutdown']) assert.ok(extension.handlers.has(event));
      if (feature === 'vi-mode') {
        const installed: unknown[] = [];
        const ctx = {hasUI: true, ui: {getEditorText: () => "", setEditorText: () => {}, setEditorComponent: (factory: unknown) => installed.push(factory)}};
        for (const hook of extension.handlers.get('session_start') ?? []) await hook({type: 'session_start', reason: 'startup'}, ctx);
        assert.equal(typeof installed[0], 'function', 'vi registers a real editor factory');
        for (const hook of extension.handlers.get('session_shutdown') ?? []) await hook({type: 'session_shutdown', reason: 'exit'}, ctx);
        assert.equal(installed.at(-1), undefined, 'vi removes its editor at shutdown');
      }
    }
    const loader = new DefaultResourceLoader({cwd: temp, agentDir: join(temp, 'agent'), settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, intended.length);
  } finally { await rm(temp, {recursive: true, force: true}); }
});


test('bundled tools work without a global classifier in a real headless session', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-managed-tools-'));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const agentDir = join(temp, 'agent');
    const settingsManager = SettingsManager.inMemory({packages: [root]});
    const resourceLoader = new DefaultResourceLoader({cwd: temp, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true});
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false});
    ({session} = await createAgentSession({cwd: temp, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(temp), modelRuntime}));
    await session.bindExtensions({});
    const runner = session.extensionRunner!;
    const errors: unknown[] = [];
    runner.onError(error => errors.push(error));
    for (const [toolName, input] of [
      ['memory', {action: 'write', scope: 'project', name: 'fixture', content: 'synthetic memory'}],
      ['todo_write', {todos: [{content: 'Synthetic task', status: 'pending'}]}],
      ['questionnaire', {questions: [{id: 'test', prompt: 'Test?', options: [], allowOther: true}]}],
    ] as const) {
      const decision = await runner.emitToolCall({type: 'tool_call', toolName, toolCallId: `managed-${toolName}`, input});
      assert.notEqual(decision?.block, true, `${toolName}: ${decision?.reason}`);
      const tool = session.getToolDefinition(toolName)!;
      await tool.execute(`managed-${toolName}`, input, undefined, undefined, runner.createContext());
    }
    const unknown = await runner.emitToolCall({type: 'tool_call', toolName: 'untrusted_remote_tool', toolCallId: 'unknown', input: {}});
    assert.notEqual(unknown?.block, true, 'no global auto-mode tool gate is installed');
    assert.deepEqual(errors, []);
    await runner.emit({type: 'session_shutdown', reason: 'quit'});
  } finally {session?.dispose(); await rm(temp, {recursive: true, force: true});}
});
