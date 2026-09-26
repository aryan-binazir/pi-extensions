import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, ModelRuntime, SessionManager, DefaultPackageManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { setActiveCwd } from '../extensions/worktree/routing.ts';

const root = resolve(import.meta.dirname, '..');
const expected = new Map<string, { tools: string[]; commands: string[]; shortcuts: string[] }>([
  ['questionnaire', {tools: ['questionnaire'], commands: [], shortcuts: []}],
  ['todo', {tools: ['todo_write'], commands: [], shortcuts: []}],
  ['effort', {tools: [], commands: ['effort'], shortcuts: []}],
  ['btw', {tools: [], commands: ['btw', 'side'], shortcuts: []}],
  ['vi-mode', {tools: [], commands: [], shortcuts: []}],
  ['prompt-stash', {tools: [], commands: [], shortcuts: []}],
  ['subagents', {tools: ['subagent', 'subagent_cancel', 'subagent_status', 'workflow'], commands: ['subagents'], shortcuts: []}],
  ['worktree', {tools: ['bash'], commands: ['worktree'], shortcuts: []}],
  ['computer-use', {tools: process.platform === 'darwin' ? ['computer_accessibility', 'computer_apps', 'computer_click', 'computer_key', 'computer_screenshot', 'computer_scroll', 'computer_type'] : ['computer_accessibility', 'computer_click', 'computer_screenshot', 'computer_scroll', 'computer_type'], commands: [], shortcuts: []}],
  ['fast-mode', {tools: [], commands: ['fast'], shortcuts: []}],
  ['auto-caffeinate', {tools: [], commands: [], shortcuts: []}],
  ['auto-permissions-status', {tools: [], commands: [], shortcuts: []}],
  ['nvim-ide', {tools: ['nvim_context', 'nvim_diagnostics', 'nvim_open'], commands: ['vim'], shortcuts: []}],
  ['guard', {tools: [], commands: [], shortcuts: []}],
]);
const intended = [...expected.keys()];

test('Pi package discovers every declared entrypoint and independently loads each', async () => {
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
      const featureContract = expected.get(feature)!;
      assert.deepEqual([...extension.tools.keys()].sort(), featureContract.tools, feature);
      assert.deepEqual([...extension.commands.keys()].sort(), featureContract.commands, feature);
      assert.deepEqual([...extension.shortcuts.keys()].sort(), featureContract.shortcuts, feature);
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


test('todo and questionnaire execute in a real headless session behind no tool gate', async () => {
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
      ['todo_write', {todos: [{content: 'Synthetic task', status: 'pending'}]}],
      ['questionnaire', {questions: [{id: 'test', prompt: 'Test?', options: [], allowOther: true}]}],
    ] as const) {
      const decision = await runner.emitToolCall({type: 'tool_call', toolName, toolCallId: `managed-${toolName}`, input});
      assert.equal(decision, undefined, `${toolName}: ${decision?.reason}`);
      const tool = session.getToolDefinition(toolName)!;
      await tool.execute(`managed-${toolName}`, input, undefined, undefined, runner.createContext());
    }
    const unknown = await runner.emitToolCall({type: 'tool_call', toolName: 'untrusted_remote_tool', toolCallId: 'unknown', input: {}});
    assert.equal(unknown, undefined, 'no global auto-mode tool gate is installed');
    assert.deepEqual(errors, []);
    await runner.emit({type: 'session_shutdown', reason: 'quit'});
  } finally {session?.dispose(); await rm(temp, {recursive: true, force: true});}
});


async function packageSession(run: (h: { session: any; runner: any; temp: string; agentDir: string }) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'pi-package-session-'));
  const agentDir = join(temp, 'agent');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({packages: [root]});
    const resourceLoader = new DefaultResourceLoader({cwd: temp, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true});
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false});
    ({session} = await createAgentSession({cwd: temp, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(temp), modelRuntime}));
    await session.bindExtensions({});
    await run({session, runner: session.extensionRunner!, temp, agentDir});
    await session.extensionRunner!.emit({type: 'session_shutdown', reason: 'quit'});
  } finally {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(temp, {recursive: true, force: true});
  }
}

test('todo, subagents and worktree each append to the same system prompt in manifest order', async () => packageSession(async ({session, runner, temp}) => {
  await session.getToolDefinition('todo_write')!.execute('t1', {todos: [{content: 'Composed task', status: 'pending'}]}, undefined, undefined, runner.createContext());
  const checkout = join(temp, 'checkout'); await mkdir(checkout);
  const sessionId = session.sessionManager.getSessionId();
  setActiveCwd(temp, checkout, sessionId);
  try {
    const result = await runner.emitBeforeAgentStart('hi', undefined, 'BASE_PROMPT', {});
    assert.match(result!.systemPrompt!, /^BASE_PROMPT\n\n[\s\S]*\[pending\] Composed task[\s\S]*Default profile \(used when profile is omitted\): implement[\s\S]*Active worktree directory: /);
  } finally { setActiveCwd(temp, undefined, sessionId); }
}));

test('the guard blocks a non-draft PR through the bash tool that worktree supplies in a real session', async () => packageSession(async ({runner, agentDir}) => {
  await mkdir(agentDir, {recursive: true});
  await writeFile(join(agentDir, 'guard.json'), JSON.stringify({requireDraftPr: true, blockAdminMerge: true}));
  const decision = await runner.emitToolCall({type: 'tool_call', toolName: 'bash', toolCallId: 'g', input: {command: 'gh pr create --title x'}});
  assert.deepEqual(decision, {block: true, reason: 'Create PRs as drafts. Add --draft; mark ready with gh pr ready after review.'});
}));
