import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent';

import { withPi } from './pi-session.ts';

const root = resolve(import.meta.dirname, '..');
const expected = new Map<string, { tools: string[]; commands: string[]; shortcuts: string[] }>([
  ['hooks', {tools: [], commands: [], shortcuts: []}],
  ['questionnaire', {tools: ['questionnaire'], commands: [], shortcuts: []}],
  ['todo', {tools: ['todo_write'], commands: [], shortcuts: ['alt+t']}],
  ['effort', {tools: [], commands: ['effort'], shortcuts: []}],
  ['btw', {tools: [], commands: ['btw', 'side'], shortcuts: []}],
  ['vi-mode', {tools: [], commands: [], shortcuts: []}],
  ['prompt-stash', {tools: [], commands: [], shortcuts: []}],
  ['escape-continue', {tools: [], commands: [], shortcuts: []}],
  ['subagents', {tools: ['subagent', 'subagent_cancel', 'subagent_status', 'workflow'], commands: ['subagents'], shortcuts: ['alt+r']}],
  ['computer-use', {tools: process.platform === 'darwin' ? ['computer_accessibility', 'computer_apps', 'computer_click', 'computer_key', 'computer_screenshot', 'computer_scroll', 'computer_type'] : ['computer_accessibility', 'computer_click', 'computer_screenshot', 'computer_scroll', 'computer_type'], commands: [], shortcuts: []}],
  ['fast-mode', {tools: [], commands: ['fast'], shortcuts: []}],
  ['auto-caffeinate', {tools: [], commands: [], shortcuts: []}],
  ['auto-permissions-status', {tools: [], commands: [], shortcuts: []}],
  ['nvim-ide', {tools: ['nvim_context', 'nvim_diagnostics', 'nvim_open'], commands: ['vim'], shortcuts: []}],
]);
const intended = [...expected.keys()];

test('Pi package discovers every declared entrypoint and independently loads each', async () => {
  await withPi({ settings: { packages: [root] } }, async ({ cwd: temp, agentDir, runtime }) => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi.extensions, intended.map(name => `./extensions/${name}/index.ts`));
    const settingsManager = runtime.services.settingsManager;
    const manager = new DefaultPackageManager({ cwd: temp, agentDir, settingsManager });
    const paths = await manager.resolve();
    assert.deepEqual(paths.extensions.map(entry => entry.path).sort(), intended.map(name => join(root, 'extensions', name, 'index.ts')).sort());
    for (const entry of paths.extensions) {
      await withPi({ settings: { packages: [{ source: root, extensions: [entry.path.slice(root.length + 1)] }] } }, async ({ runtime, runner }) => {
        const loaded = runtime.services.resourceLoader.getExtensions();
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
          const ctx = {...runner.createContext(), hasUI: true, ui: {...runner.createContext().ui, getEditorText: () => "", setEditorText: () => {}, setEditorComponent: (factory: unknown) => installed.push(factory)}};
          for (const hook of extension.handlers.get('session_start') ?? []) await hook({type: 'session_start', reason: 'startup'}, ctx);
          assert.equal(typeof installed[0], 'function', 'vi registers a real editor factory');
          for (const hook of extension.handlers.get('session_shutdown') ?? []) await hook({type: 'session_shutdown', reason: 'exit'}, ctx);
          assert.equal(installed.at(-1), undefined, 'vi removes its editor at shutdown');
        }
      });
    }
    assert.deepEqual(runtime.services.resourceLoader.getExtensions().errors, []);
    assert.equal(runtime.services.resourceLoader.getExtensions().extensions.length, intended.length);
  });
});


test('todo and questionnaire execute in a real headless session behind no tool gate', async () => {
  await withPi({ settings: { packages: [root] } }, async ({ session, runner }) => {
    for (const [toolName, input] of [
      ['todo_write', {todos: [{content: 'Synthetic task', status: 'pending'}]}],
      ['questionnaire', {questions: [{id: 'test', prompt: 'Test?', options: [], allowOther: true}]}],
    ] as const) {
      const decision = await runner.emitToolCall({type: 'tool_call', toolName, toolCallId: `managed-${toolName}`, input});
      assert.equal(decision, undefined, `${toolName}: ${decision?.reason}`);
      const tool = session.getToolDefinition(toolName)!;
      await tool.execute(`managed-${toolName}`, input, undefined, undefined, runner.createToolContext(`managed-${toolName}`, undefined));
    }
    const unknown = await runner.emitToolCall({type: 'tool_call', toolName: 'untrusted_remote_tool', toolCallId: 'unknown', input: {}});
    assert.equal(unknown, undefined, 'no global auto-mode tool gate is installed');
  });
});


test('todo context composes with the structured subagent prompt section', async () => withPi({ settings: { packages: [root] } }, async ({session, runner, cwd}) => {
  await session.getToolDefinition('todo_write')!.execute('t1', {todos: [{content: 'Composed task', status: 'pending'}]}, undefined, undefined, runner.createToolContext('t1', undefined));
  const result = await runner.emitBeforeAgentStart('hi', undefined, {cwd, customPrompt: 'BASE_PROMPT'});
  const context = await runner.emitContext([]);
  const reminder = context.at(-1)!;
  assert.ok('content' in reminder);
  assert.match(String(reminder.content), /\[pending\] Composed task/);
  assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
  assert.equal(result.systemPromptOptions.customPrompt, 'BASE_PROMPT');
  assert.match(result.systemPromptOptions.sections.subagent_profiles, /Default profile \(used when profile is omitted\): implement/);
  assert.doesNotMatch(JSON.stringify(result.systemPromptOptions.sections), /Composed task/);
}));

test('hooks block before a later package such as Auto Permissions sees the call, and allowed calls still reach it', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'pi-hooks-order-'));
  const reviewer = join(fixtures, 'reviewer.ts');
  const seen = Symbol.for('pi-extensions.test.reviewed-tool-calls');
  const reviewed = (globalThis as Record<symbol, string[]>)[seen] = [];
  try {
    await writeFile(reviewer, `export default pi => pi.on('tool_call', event => { globalThis[Symbol.for('pi-extensions.test.reviewed-tool-calls')].push(event.toolCallId); });\n`);
    await withPi({ settings: { packages: [root, reviewer] } }, async ({runner}) => {
      const blocked = await runner.emitToolCall({type: 'tool_call', toolName: 'bash', toolCallId: 'protected', input: {command: 'rm personal-settings/hooks.yaml'}});
      assert.equal(blocked?.block, true);
      assert.ok(blocked?.reason);
      assert.match(blocked.reason, /^\[hooks: protection\] /);
      assert.equal(await runner.emitToolCall({type: 'tool_call', toolName: 'bash', toolCallId: 'allowed', input: {command: 'git status'}}), undefined);
      assert.deepEqual(reviewed, ['allowed']);
    });
  } finally {
    delete (globalThis as Record<symbol, unknown>)[seen];
    await rm(fixtures, {recursive: true, force: true});
  }
});
