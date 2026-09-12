import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createInspectionFindTool, createInspectionGrepTool } from './inspection.ts';

async function fixture(body: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'sentinel-owned-inspection-'));
  const env = { ...process.env }, fetch = globalThis.fetch;
  try {
    process.env.PATH = join(home, 'path');
    process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
    await mkdir(process.env.PATH);
    await mkdir(join(home, 'agent', 'bin'), { recursive: true });
    await body(home);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    globalThis.fetch = fetch;
    await rm(home, { recursive: true, force: true });
  }
}
async function binary(path: string, code: string) {
  await writeFile(path, `#!${process.execPath}\n${code}\n`);
  await chmod(path, 0o755);
}
const signal = () => new AbortController().signal;
const text = (result: any) => result.content[0].text as string;

test('missing tools never fetch, install, or write; signal is mandatory', async () => {
  await fixture(async home => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; throw new Error('fetch tripwire'); };
    for (const tool of [createInspectionFindTool(home), createInspectionGrepTool(home)]) {
      await assert.rejects(tool.execute('missing', { pattern: 'synthetic' }, signal()), /dependency unavailable/);
      await assert.rejects(tool.execute('missing-signal', { pattern: 'synthetic' }), /cancellation signal/);
    }
    assert.equal(fetched, false);
    assert.deepEqual(await readdir(join(home, 'agent', 'bin')), []);
    assert.deepEqual(await readdir(join(home, 'path')), []);
    assert.deepEqual(await readdir(home), ['agent', 'path']);
  });
});

test('existing agent bin, PATH fd/fdfind and rg execute with separated arguments and capped bounds', async () => {
  await fixture(async home => {
    await mkdir(join(home, '-target'));
    for (const [name, directory] of [['rg', 'agent/bin'], ['fd', 'path'], ['fdfind', 'path']]) {
      const file = join(home, directory, name);
      await binary(file, 'require("node:fs").writeSync(1, JSON.stringify(process.argv.slice(2)))');
      const tool = name === 'rg' ? createInspectionGrepTool(home) : createInspectionFindTool(home);
      const argsInput = { pattern: '--exec=synthetic', path: '-target', glob: '--pre=synthetic', context: 999, limit: 99999 };
      const output = text(await tool.execute('args', argsInput, signal()));
      const args = JSON.parse(output.split('\n')[0]);
      assert.equal(args.at(-1), join(home, '-target'));
      if (name === 'rg') {
        assert.ok(args.includes('--no-config'));
        assert.ok(args.includes('--max-filesize=2M'));
        assert.ok(args.includes('--context=20'));
        assert.ok(args.includes('--max-count=1000'));
        assert.ok(args.includes('--regexp=--exec=synthetic'));
        assert.ok(args.includes('--glob=--pre=synthetic'));
        assert.equal(args.at(-2), '--');
      } else {
        assert.equal(args.at(-3), '--');
        assert.equal(args.at(-2), '--exec=synthetic');
        assert.equal(args[args.indexOf('--max-results') + 1], '1000');
        assert.ok(!args.includes('--exec') && !args.includes('-x'));
      }
      assert.match(output, /not exhaustive/);
      await rm(file);
      await assert.rejects(tool.execute('removed', { pattern: '*' }, signal()), /dependency unavailable/);
    }
  });
});

test('non-executable files and directories are not dependencies; spawn errors fail closed', async () => {
  await fixture(async home => {
    await mkdir(join(home, 'agent', 'bin', 'rg'));
    const path = join(home, 'path', 'rg');
    await writeFile(path, 'synthetic');
    await assert.rejects(createInspectionGrepTool(home).execute('bad', { pattern: 'x' }, signal()), /dependency unavailable/);
    await writeFile(path, '#!/missing-synthetic-interpreter\n');
    await chmod(path, 0o755);
    await assert.rejects(createInspectionGrepTool(home).execute('bad', { pattern: 'x' }, signal()), /ENOENT/);
  });
});

test('abort and combined stdout/stderr overflow kill and reap the child before rejection', async () => {
  await fixture(async home => {
    for (const mode of ['abort', 'overflow']) {
      const pidFile = join(home, `${mode}.pid`);
      await binary(join(home, 'path', 'fd'), `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
${mode === 'overflow' ? "fs.writeSync(1, 'x'.repeat(40000)); fs.writeSync(2, 'x'.repeat(40000));" : ''}
setInterval(() => {}, 1000);`);
      const controller = new AbortController();
      const pending = createInspectionFindTool(home).execute(mode, { pattern: '*' }, controller.signal);
      const rejection = assert.rejects(pending, mode === 'abort' ? /aborted/ : /output budget/);
      try {
        for (let n = 0; n < 200; n++) {
          try { await access(pidFile); break; } catch { await delay(10); }
        }
        const pid = Number(await readFile(pidFile, 'utf8'));
        if (mode === 'abort') controller.abort();
        await rejection;
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally { controller.abort(); await rejection; }
    }
  });
});

test('real contextual rg omits oversized files and ignores configured preprocessors', async t => {
  try { await access('/usr/bin/rg'); } catch { t.skip('actual rg absent'); return; }
  await fixture(async home => {
    process.env.PATH = '/usr/bin';
    const marker = join(home, 'preprocessor-ran');
    const preprocessor = join(home, 'preprocessor');
    await binary(preprocessor, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);
    const config = join(home, 'rg-config');
    await writeFile(config, `--pre=${preprocessor}\n`);
    process.env.RIPGREP_CONFIG_PATH = config;
    await writeFile(join(home, 'small.txt'), 'before\nSYNTHETIC_NEEDLE\nafter\n');
    await writeFile(join(home, 'large.txt'), 'SYNTHETIC_NEEDLE\n' + 'x'.repeat(2 * 1024 * 1024));
    process.env.HOME = home;
    const output = text(await createInspectionGrepTool(home).execute('real', { pattern: 'SYNTHETIC_NEEDLE', path: '~', context: 1, glob: '*.txt' }, signal()));
    assert.match(output, /small.txt.*before/);
    assert.match(output, /small.txt.*after/);
    assert.doesNotMatch(output, /large.txt/);
    assert.match(output, /Files >2MiB may be omitted/);
    await assert.rejects(createInspectionGrepTool(home).execute('large-direct', { pattern: 'SYNTHETIC_NEEDLE', path: 'large.txt', context: 1 }, signal()), /at most 2MiB/);
    await assert.rejects(access(marker));
  });
});


test('real fd truncates directory results explicitly and supports path globs', async t => {
  try { await access('/usr/bin/fd'); } catch {
    try { await access('/usr/bin/fdfind'); } catch { t.skip('system fd/fdfind absent'); return; }
  }
  await fixture(async home => {
    process.env.PATH = '/usr/bin';
    await mkdir(join(home, 'src'));
    for (const name of ['one.txt', 'two.txt', 'three.txt']) await writeFile(join(home, 'src', name), 'synthetic');
    const output = text(await createInspectionFindTool(home).execute('real', { pattern: 'src/*.txt', limit: 1 }, signal()));
    assert.equal(output.split('\n').filter(line => line.endsWith('.txt')).length, 1);
    assert.match(output, /at most 1 results; reaching this limit truncates/);
    assert.match(output, /not exhaustive/);
  });
});
