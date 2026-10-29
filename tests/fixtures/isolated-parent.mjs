import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import computerUse from '../../extensions/computer-use/index.ts';

const pi = { on() {}, registerTool(tool) {
  if (tool.name === 'computer_open') {
    void tool.execute('fixture', { url: 'https://example.com' }, undefined, undefined, {}).then(async () => {
      const root = process.env.XDG_RUNTIME_DIR;
      const directory = (await readdir(root)).find(name => name.startsWith('pi-cu-'));
      process.stdout.write(JSON.stringify({ runtime: join(root, directory) }) + '\n');
    }).catch(error => { console.error(error); process.exit(1); });
  }
} };
computerUse(pi);
setInterval(() => {}, 1000);
