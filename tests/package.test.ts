import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = resolve(import.meta.dirname, '..');
const intended = ['questionnaire', 'memory', 'todo', 'effort', 'btw', 'vi-mode', 'prompt-stash'];

test('Pi package discovers exactly seven entrypoints and independently loads each', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-package-test-'));
  try {
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
      };
      assert.deepEqual([...extension.tools.keys()].sort(), expected[feature].tools, feature);
      assert.deepEqual([...extension.commands.keys()].sort(), expected[feature].commands, feature);
      assert.deepEqual([...extension.shortcuts.keys()].sort(), expected[feature].shortcuts, feature);
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
    assert.equal(loader.getExtensions().extensions.length, 7);
  } finally { await rm(temp, {recursive: true, force: true}); }
});
