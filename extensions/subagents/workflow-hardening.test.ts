import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWorkflow } from './workflow.ts';
import { withHost } from './test-support.ts';

test('journal loading does not follow a substituted symlink', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-link-'));
  const journalDirectory = join(cwd, 'journals');
  const options = {source: "return await api.checkpoint('one',async()=>1);", cwd, journalDirectory, policyIdentity: 'journal-link', approve: async () => true, approveReplay: async () => true, spawn: async () => { throw new Error('unused'); }};
  try {
    await runWorkflow(options);
    const journal = join(journalDirectory, (await readdir(journalDirectory))[0]);
    const path = join(journal, (await readdir(journal))[0]);
    await rename(path, `${path}.original`);
    await symlink(`${path}.original`, path);
    await assert.rejects(runWorkflow(options), /ELOOP|symbolic link/);
    await rm(path);
    await rename(`${path}.original`, path);
    await rename(journal, `${journal}.original`);
    await symlink(`${journal}.original`, journal);
    await assert.rejects(runWorkflow(options), /must be a directory/);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('workflow retry returns supervision failures to its orchestrator without relaunching', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-stalled-'));
  let launches = 0;
  try {
    await assert.rejects(runWorkflow({source: "return await api.retry(5,()=>api.spawn({task:'stalled'},'child'));", cwd, journalDirectory: join(cwd, 'journals'), policyIdentity: 'stalled', approve: async () => true,
      spawn: async () => { launches++; throw Object.assign(new Error('Child stalled'), {retryable: false}); },
    }), /Child stalled/);
    assert.equal(launches, 1);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('a changed ancestor cannot substitute another file after read authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-path-'));
  const cwd = join(root, 'workspace'), data = join(cwd, 'data'), outside = join(root, 'outside');
  try {
    await mkdir(data, {recursive: true}); await mkdir(outside);
    await writeFile(join(data, 'file'), 'allowed'); await writeFile(join(outside, 'file'), 'synthetic outside');
    await assert.rejects(runWorkflow({source: "return await api.readFile('data/file');", cwd, journalDirectory: join(root, 'journals'), policyIdentity: 'path', approve: async () => true,
      authorizeRead: async () => { await rm(data, {recursive: true}); await symlink(outside, data); },
      spawn: async () => { throw new Error('unused'); },
    }), /changed during authorization/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('multibyte stage records cannot exceed their reload byte limit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-bytes-'));
  try {
    await assert.rejects(runWorkflow({
      source: "return await api.spawn({task:'large'},'large');",
      cwd, journalDirectory: join(cwd, 'journals'), policyIdentity: 'bytes', approve: async () => true,
      spawn: async () => '界'.repeat(400000),
    }), /journal exceeds limit/);
    assert.deepEqual(await readdir(join(cwd, 'journals')), []);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('known journal-write failure cannot be retried into undurable success', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-failure-'));
  const journalDirectory = join(cwd, 'journals');
  let effects = 0;
  try {
    await assert.rejects(runWorkflow({
      source: "return await api.retry(2,()=>api.spawn({task:'synthetic effect'},'once'));",
      cwd, journalDirectory, policyIdentity: 'test', approve: async () => true,
      spawn: async () => { effects++; await rm(journalDirectory, {recursive: true, force: true}); return 'effect'; },
    }), /persistence failed/);
    assert.equal(effects, 1, 'known failure must return control for reconciliation, not repeat the effect');
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

const hour = 60 * 60 * 1000, day = 24 * hour;
const age = (path: string, ms: number) => utimes(path, new Date(Date.now() - ms), new Date(Date.now() - ms));
const stageFiles = async (journalDirectory: string) => {
  const [journal, ...others] = await readdir(journalDirectory);
  assert.deepEqual(others, []);
  const directory = join(journalDirectory, journal);
  return Promise.all((await readdir(directory)).map(async name => (await stat(join(directory, name))).size));
};

test('large stage outputs past the old 1 MiB journal total complete and replay identically', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-large-'));
  const journalDirectory = join(cwd, 'journals');
  let launches = 0;
  let replayed: string[] = [];
  const options = {
    source: "const seen = []; for (let i = 0; i < 20; i++) { const r = await api.spawn({task: 'stage ' + i}, 's' + i); seen.push([r.id, r.output.length, r.usage.output]); } return [seen, await api.checkpoint('count', async () => seen.length)];",
    cwd, journalDirectory, policyIdentity: 'large', approve: async () => true, approveReplay: async (stages: string[]) => { replayed = stages; return true; },
    spawn: async (task: {task: string}) => ({id: `child-${++launches}`, task: task.task, status: 'succeeded', output: 'x'.repeat(60000), stderr: '', usage: {input: launches, output: launches}}),
  };
  try {
    const first = await runWorkflow(options);
    assert.equal(launches, 20);
    const sizes = await stageFiles(journalDirectory);
    assert.equal(sizes.length, 21);
    assert.ok(sizes.every(size => size < 61000), 'each file holds one stage, not the whole journal');
    assert.ok(sizes.reduce((a, b) => a + b) > 1024 * 1024);
    assert.deepEqual(await runWorkflow(options), first);
    assert.equal(launches, 20);
    assert.deepEqual([...replayed].sort(), ['checkpoint:count', ...Array.from({length: 20}, (_, i) => `spawn:s${i}`)].sort());
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('an exhausted journal budget rejects stages before launch and checkpoints catchably, also on replay', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-budget-'));
  const journalDirectory = join(cwd, 'journals');
  let launches = 0;
  const options = {
    source: "let i = 0; try { for (; i < 40; i++) await api.spawn({task: 'stage ' + i}, 's' + i); } catch (error) { let big = 'stored'; try { await api.checkpoint('big', async () => 'x'.repeat(1000000)); } catch (failure) { big = failure.message; } return [i, error.message, big, await api.checkpoint('small', async () => 'fits')]; } return [i, 'completed'];",
    cwd, journalDirectory, policyIdentity: 'budget', approve: async () => true, approveReplay: async () => true,
    spawn: async () => { launches++; return 'x'.repeat(1000000); },
  };
  try {
    const first = await runWorkflow(options);
    const [stage, message, big, small] = first as [number, string, string, string];
    assert.match(message, /budget exhausted/);
    assert.match(big, /budget exhausted/);
    assert.equal(small, 'fits');
    assert.ok(stage > 30 && stage < 34, `failed at stage ${stage}`);
    assert.equal(launches, stage, 'the failing stage never launched its child');
    assert.equal((await stageFiles(journalDirectory)).length, stage + 1);
    assert.deepEqual(await runWorkflow(options), first);
    assert.equal(launches, stage, 'replay does not relaunch any child');
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('concurrent spawns beyond the journal reservations wait instead of failing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-reserve-'));
  let running = 0, peak = 0, open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  try {
    assert.equal(await runWorkflow({
      source: "return (await Promise.all(Array.from({length: 40}, (_, i) => api.spawn({task: 'parallel ' + i}, 'p' + i)))).length;",
      cwd, journalDirectory: join(cwd, 'journals'), policyIdentity: 'reserve', approve: async () => true,
      spawn: async () => { peak = Math.max(peak, ++running); if (running === 32) setTimeout(open, 100); await gate; running--; return 'small'; },
    }), 40);
    assert.equal(peak, 32);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('journal retention prunes stale and excess idle journals, keeping recent and foreign entries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-retention-'));
  const journalDirectory = join(cwd, 'journals');
  const id = (n: number) => n.toString(16).padStart(64, '0');
  try {
    await mkdir(journalDirectory);
    for (let n = 0; n < 24; n++) await mkdir(join(journalDirectory, id(n)));
    for (let n = 0; n < 18; n++) await age(join(journalDirectory, id(n)), n * 1000);
    for (let n = 18; n < 22; n++) await age(join(journalDirectory, id(n)), 3 * hour);
    await age(join(journalDirectory, id(22)), 8 * day);
    await writeFile(join(journalDirectory, `${id(24)}.json`), '{}');
    await age(join(journalDirectory, `${id(24)}.json`), 8 * day);
    await writeFile(join(journalDirectory, `${id(25)}.json`), '{}');
    await writeFile(join(journalDirectory, 'notes.txt'), 'foreign');
    await age(join(journalDirectory, 'notes.txt'), 30 * day);
    await runWorkflow({source: 'return 1;', cwd, journalDirectory, policyIdentity: 'retention', approve: async () => true, spawn: async () => 'unused'});
    assert.deepEqual((await readdir(journalDirectory)).sort(), [...Array.from({length: 18}, (_, n) => id(n)), id(23), `${id(25)}.json`, 'notes.txt'].sort());
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('a running workflow journal is never pruned and replay marks a journal as recently used', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-running-'));
  const journalDirectory = join(cwd, 'journals');
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spawned = new Promise<void>(resolve => { started = resolve; });
  const options = {source: "await api.checkpoint('first', async () => 1); return await api.spawn({task: 'hold'}, 'hold');", cwd, journalDirectory, policyIdentity: 'running', approve: async () => true, approveReplay: async () => true, spawn: async () => { started(); await held; return 'held'; }};
  try {
    const running = runWorkflow(options);
    await spawned;
    const [journal] = await readdir(journalDirectory);
    await age(join(journalDirectory, journal), 30 * day);
    await runWorkflow({...options, source: 'return 2;'});
    assert.deepEqual(await readdir(journalDirectory), [journal]);
    release();
    assert.equal(await running, 'held');
    await age(join(journalDirectory, journal), 7 * day - hour);
    assert.equal(await runWorkflow(options), 'held');
    assert.ok((await stat(join(journalDirectory, journal))).mtimeMs > Date.now() - hour);
  } finally { release(); await rm(cwd, {recursive: true, force: true}); }
});

test('registered workflow children with large output and stderr journal bounded results and replay them', async () => {
  const pi = `require('node:fs').appendFileSync('launches.log','x');process.stderr.write('e'.repeat(100000));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'\u754c'.repeat(60000)}]}}));`;
  await withHost({prefix: 'workflow-large-children-', pi, tools: ['read']}, async host => {
    const source = "const seen = []; for (let i = 0; i < 6; i++) { const r = await api.spawn({task: 'large ' + i, preset: 'reader'}, 's' + i); seen.push([r.id, r.status, r.task, r.output.length, r.stderr]); } return seen;";
    const first = (await host.execute('workflow', {source})).details;
    assert.equal(first.length, 6);
    for (const [, status, , length, stderr] of first) {
      assert.equal(status, 'succeeded');
      assert.equal(length, 60000);
      assert.ok(stderr.length > 0 && Buffer.byteLength(JSON.stringify(stderr)) <= 4096 && /^e+$/.test(stderr));
    }
    const sizes = await stageFiles(join(host.agentDir, 'workflow-journals'));
    assert.equal(sizes.length, 6);
    assert.ok(sizes.every(size => size < 180000 + 8192));
    assert.deepEqual((await host.execute('workflow', {source})).details, first);
    assert.equal(await readFile(join(host.cwd, 'launches.log'), 'utf8'), 'x'.repeat(6));
  });
});
