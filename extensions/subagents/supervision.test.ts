import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SubagentRegistry } from './registry.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function alive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z ');
    return true;
  } catch { return false; }
}

test('supervised cancellation signals Pi once and allows its graceful cleanup', {timeout: 5000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-grace-'));
  const previousPath = process.env.PATH;
  const registry = new SubagentRegistry();
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nlet signals=0;process.on('SIGTERM',()=>{signals++;setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:String(signals)}]}}));process.exit(0);},300);});console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'armed'}}));setInterval(()=>{},1000);`);
    await chmod(join(cwd, 'pi'), 0o700);
    process.env.PATH = `${cwd}:${previousPath ?? ''}`;
    const task = await registry.spawn({task: 'graceful synthetic child', cwd});
    const deadline = Date.now() + 2000;
    while (registry.get(task.id)?.output !== 'armed' && Date.now() < deadline) await sleep(10);
    assert.equal(registry.get(task.id)?.output, 'armed');
    registry.cancel(task.id);
    const value = await task.done;
    assert.equal(value.status, 'cancelled');
    assert.equal(value.output, '1');
  } finally {
    await registry.shutdown();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(cwd, {recursive: true, force: true});
  }
});

test('a normally completed supervised child releases its owner pipe and settles', {timeout: 10000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-complete-'));
  const previousPath = process.env.PATH;
  const registry = new SubagentRegistry();
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));`);
    await chmod(join(cwd, 'pi'), 0o700);
    process.env.PATH = `${cwd}:${previousPath ?? ''}`;
    const task = await registry.spawn({task: 'synthetic completion', cwd});
    const value = await task.done;
    assert.equal(value.status, 'succeeded');
    assert.equal(value.output, 'done');
  } finally {
    await registry.shutdown();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(cwd, {recursive: true, force: true});
  }
});

test('a supervised child stops when its owning process is abruptly killed', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-owner-'));
  let childPid: number | undefined, grandchildPid: number | undefined;
  let owner: ReturnType<typeof spawn> | undefined;
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nconst child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);"],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:process.pid+','+child.pid}})));setInterval(()=>{},1000);`);
    await chmod(join(cwd, 'pi'), 0o700);
    const script = `import {SubagentRegistry} from ${JSON.stringify(new URL('./registry.ts', import.meta.url).href)}; const registry = new SubagentRegistry({onUpdate: task=>{if(task.output)console.log(task.output);}});await registry.spawn({task:'synthetic child only',cwd:${JSON.stringify(cwd)},timeout:8000});`;
    owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {cwd: import.meta.dirname, env: {...process.env, PATH: `${cwd}:${process.env.PATH ?? ''}`}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', errors = '';
    owner.stdout?.on('data', chunk => { output += String(chunk); });
    owner.stderr?.on('data', chunk => { errors += String(chunk); });
    const startup = Date.now() + 8000;
    while (!/^\d+,\d+\n/.test(output) && Date.now() < startup && owner.exitCode === null) await sleep(20);
    [childPid, grandchildPid] = output.trim().split('\n')[0].split(',').map(Number);
    assert.ok(childPid > 0 && grandchildPid > 0, `Child and grandchild must start: ${errors}`);
    const closed = new Promise<void>(resolve => owner!.once('close', () => resolve()));
    owner.kill('SIGKILL');
    await closed;
    const deadline = Date.now() + 3000;
    while ((await alive(childPid) || await alive(grandchildPid)) && Date.now() < deadline) await sleep(25);
    assert.equal(await alive(childPid), false, 'orphaned child must stop without a parent shutdown hook');
    assert.equal(await alive(grandchildPid), false, 'ordinary descendants ignoring SIGTERM must also stop');
  } finally {
    owner?.kill('SIGKILL');
    for (const pid of [childPid, grandchildPid]) if (pid && await alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await rm(cwd, {recursive: true, force: true});
  }
});
