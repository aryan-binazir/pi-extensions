import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = resolve(import.meta.dirname, '..');
const intended = ['questionnaire', 'memory', 'todo', 'effort', 'btw', 'vi-mode', 'prompt-stash'];

test('Pi package discovers exactly seven entrypoints and independently loads each', async () => {
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
    }
    const loader = new DefaultResourceLoader({cwd: temp, agentDir: join(temp, 'agent'), settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 7);
  } finally { await rm(temp, {recursive: true, force: true}); }
});
