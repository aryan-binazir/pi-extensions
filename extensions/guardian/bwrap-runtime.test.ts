import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withPi } from '../../tests/pi-session.ts';
import { createGuardianBashTool } from './bash.ts';
import { DEFAULT_GUARDIAN_CONFIG } from './config.ts';
import { Policy } from './rules.ts';
import { bubblewrapSandbox } from './sandbox.ts';
import { loadShell } from './shell.ts';

const shell = await loadShell();

for (const cancellation of [false, true]) {
  test(`a slow capability probe respects real bash ${cancellation ? 'cancellation' : 'deadlines'} without blocking timers`, async t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-bwrap-runtime-')));
    const cwd = join(dir, 'workspace'), bin = join(dir, 'bin');
    mkdirSync(cwd);
    mkdirSync(bin);
    const launcher = join(bin, 'bwrap'), pidFile = join(dir, 'probe.pid'), launched = join(dir, 'launched');
    writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo $$ > '${pidFile}'
  printf '%s\\n' --as-pid-1 --perms
  exec /bin/sleep 30
fi
printf launched > '${launched}'
`);
    chmodSync(launcher, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    });
    await withPi({ cwd }, async ({ runner }) => {
      const config = { ...DEFAULT_GUARDIAN_CONFIG, sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
      const tool = createGuardianBashTool({ config: () => config, policy: () => Policy.empty(), shellSettings: () => ({ shellPath: '/bin/bash' }), shell,
        sandbox: bubblewrapSandbox({ program: launcher, source: 'system' }),
        approvals: { request: async () => { throw new Error('unexpected approval'); } }, persistAmendment: async () => {} }, cwd);
      const controller = new AbortController();
      t.after(() => controller.abort());
      const start = performance.now();
      const timerDone = new Promise<number>(resolve => {
        const timer = setTimeout(() => resolve(performance.now() - start), 40);
        t.after(() => clearTimeout(timer));
      });
      const rejected = assert.rejects(tool.execute('probe-deadline', { command: 'printf should-not-run', timeout: cancellation ? 2 : 0.04 }, controller.signal, undefined,
        runner.createToolContext('probe-deadline', controller.signal)), cancellation ? /abort/i : /timed out after 0.04 seconds/);
      let pid: number | undefined;
      if (cancellation) {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { pid = Number(readFileSync(pidFile, 'utf8')); if (pid > 1) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        controller.abort();
        assert.ok(pid && pid > 1, 'the capability probe started before cancellation');
      }
      await rejected;
      const elapsed = performance.now() - start;
      const timerElapsed = await timerDone;
      t.diagnostic(JSON.stringify({ elapsed, timerElapsed }));
      assert.ok(elapsed < 500, `preparation settled after ${elapsed}ms`);
      assert.ok(timerElapsed < 500, `unrelated timer fired after ${timerElapsed}ms`);
      assert.equal(existsSync(launched), false);
      if (!pid) {
        try { pid = Number(readFileSync(pidFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!pid) { t.diagnostic('deadline stopped the probe before PID publication'); return; }
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(pid, 0); } catch { return; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`capability probe ${pid} was not reaped`);
    });
  });
}
