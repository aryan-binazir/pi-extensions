import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkflowJournal } from './workflow-journal.ts';
import { runFixtureWorkflow as runWorkflow, workflowFixture } from './test-support.ts';
import { withHost } from './test-support.ts';

test('journal loading does not follow substituted file or directory symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-link-'));
  const identity = 'a'.repeat(64);
  let journal: WorkflowJournal | undefined;
  try {
    journal = await WorkflowJournal.open(directory, identity);
    await journal.checkpoint('checkpoint:one', 1);
    await journal.close();
    const journalPath = join(directory, (await readdir(directory))[0]);
    const path = join(journalPath, (await readdir(journalPath))[0]);
    await rename(path, `${path}.original`);
    await symlink(`${path}.original`, path);
    await assert.rejects(WorkflowJournal.open(directory, identity), /ELOOP|symbolic link/);
    await rm(path);
    await rename(`${path}.original`, path);
    await rename(journalPath, `${journalPath}.original`);
    await symlink(`${journalPath}.original`, journalPath);
    await assert.rejects(WorkflowJournal.open(directory, identity), /must be a directory/);
  } finally { await journal?.close(); await rm(directory, {recursive: true, force: true}); }
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
      admission: {...workflowFixture(cwd), read: async () => { await rm(data, {recursive: true}); await symlink(outside, data); }},
      spawn: async () => { throw new Error('unused'); },
    }), /changed during authorization/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('journal rejects multibyte spawn records above the stage byte cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-bytes-'));
  const journal = await WorkflowJournal.open(directory, 'a'.repeat(64));
  try {
    await assert.rejects(journal.record('spawn:large', 'large', async () => '界'.repeat(400000)), /journal exceeds limit/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await journal.close(); await rm(directory, {recursive: true, force: true}); }
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
    source: "const seen = []; for (let i = 0; i < 5; i++) { const r = await api.spawn({task: 'stage ' + i}, 's' + i); seen.push([r.id, r.output.length, r.usage.output]); } return [seen, await api.checkpoint('count', async () => seen.length)];",
    cwd, journalDirectory, policyIdentity: 'large', approve: async () => true, approveReplay: async (stages: string[]) => { replayed = stages; return true; },
    spawn: async (task: {task: string}) => ({id: `child-${++launches}`, task: task.task, status: 'succeeded', output: 'x'.repeat(250000), stderr: '', usage: {input: launches, output: launches}}),
  };
  try {
    const first = await runWorkflow(options);
    assert.equal(launches, 5);
    const sizes = await stageFiles(journalDirectory);
    assert.equal(sizes.length, 6);
    assert.ok(sizes.every(size => size < 251000), 'each file holds one stage, not the whole journal');
    assert.ok(sizes.reduce((a, b) => a + b) > 1024 * 1024);
    assert.deepEqual(await runWorkflow(options), first);
    assert.equal(launches, 5);
    assert.deepEqual([...replayed].sort(), ['checkpoint:count', ...Array.from({length: 5}, (_, i) => `spawn:s${i}`)].sort());
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('journal budget rejects new effects and large checkpoints while small checkpoints fit, also after load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-budget-'));
  const identity = 'a'.repeat(64);
  let journal = await WorkflowJournal.open(directory, identity);
  let effects = 0;
  try {
    for (let i = 0; i < 32; i++)
      await journal.checkpoint(`checkpoint:pad${i}`, 'x'.repeat(1024 * 1024 - 1024));
    for (let resume = 0; resume < 2; resume++) {
      await assert.rejects(journal.record('spawn:next', 'next', async () => { effects++; }), {message: /budget exhausted/, retryable: false});
      await assert.rejects(journal.checkpoint('checkpoint:big', 'x'.repeat(65536)), {message: /budget exhausted/, retryable: false});
      assert.equal(journal.lookup('checkpoint:big'), undefined);
      await journal.checkpoint(`checkpoint:small${resume}`, 'fits');
      assert.equal(journal.lookup(`checkpoint:small${resume}`)?.value, 'fits');
      assert.equal(effects, 0);
      await journal.close();
      journal = await WorkflowJournal.open(directory, identity);
    }
  } finally { await journal.close(); await rm(directory, {recursive: true, force: true}); }
});

test('concurrent spawns and checkpoints beyond the journal reservations wait instead of failing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-reserve-'));
  let running = 0, peak = 0, open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  try {
    await writeFile(join(cwd, 'input'), 'ok');
    assert.deepEqual(await runWorkflow({
      source: "const spawns = Promise.all(Array.from({length: 40}, (_, i) => api.spawn({task: 'parallel ' + i}, 'p' + i))); const kept = await api.checkpoint('kept', async () => (await api.readFile('input', 2)) + (await api.readFile('input', 2))); return [(await spawns).length, kept];",
      cwd, journalDirectory: join(cwd, 'journals'), policyIdentity: 'reserve', approve: async () => true,
      spawn: async () => { peak = Math.max(peak, ++running); if (running === 32) setTimeout(open, 100); await gate; running--; return 'small'; },
    }), [40, 'okok']);
    assert.equal(peak, 32);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('journal retention prunes by age and count while keeping recent and foreign entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-retention-'));
  const id = (n: number) => n.toString(16).padStart(64, '0');
  try {
    for (let n = 0; n < 24; n++) {
      const journal = await WorkflowJournal.open(directory, id(n));
      try { await journal.checkpoint('checkpoint:one', n); }
      finally { await journal.close(); }
    }
    for (let n = 0; n < 18; n++) await age(join(directory, id(n)), n * 1000);
    for (let n = 18; n < 22; n++) await age(join(directory, id(n)), 3 * hour);
    await age(join(directory, id(22)), 8 * day);
    await writeFile(join(directory, 'notes.txt'), 'foreign');
    await age(join(directory, 'notes.txt'), 30 * day);
    const journal = await WorkflowJournal.open(directory, id(99));
    await journal.close();
    assert.deepEqual((await readdir(directory)).sort(), [...Array.from({length: 18}, (_, n) => id(n)), id(23), 'notes.txt'].sort());
  } finally { await rm(directory, {recursive: true, force: true}); }
});


test('journal ownership protects active and resumed stale journals and touch marks replay use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-running-'));
  const identity = 'a'.repeat(64);
  let journal = await WorkflowJournal.open(directory, identity);
  try {
    await journal.checkpoint('checkpoint:first', 1);
    const path = join(directory, (await readdir(directory))[0]);
    await age(path, 30 * day);
    const other = await WorkflowJournal.open(directory, 'b'.repeat(64));
    await other.close();
    assert.deepEqual(await readdir(directory), [identity]);
    await journal.close();
    journal = await WorkflowJournal.open(directory, identity);
    assert.equal(journal.lookup('checkpoint:first')?.value, 1);
    assert.ok((await stat(path)).mtimeMs < Date.now() - 29 * day);
    await journal.touch();
    assert.ok((await stat(path)).mtimeMs > Date.now() - hour);
  } finally { await journal.close(); await rm(directory, {recursive: true, force: true}); }
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

test('journal records and reopens stages through its interface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-module-'));
  const identity = 'a'.repeat(64);
  let journal: WorkflowJournal | undefined;
  try {
    journal = await WorkflowJournal.open(directory, identity);
    assert.deepEqual(journal.keys, []);
    assert.deepEqual(await readdir(directory), []);
    await journal.record('spawn:one', 'task-one', async () => ({output: 'done'}));
    await journal.checkpoint('checkpoint:count', 1);
    await journal.close();
    journal = await WorkflowJournal.open(directory, identity);
    assert.deepEqual(journal.lookup('spawn:one', 'task-one'), {signature: 'task-one', value: {output: 'done'}});
    assert.deepEqual(journal.lookup('checkpoint:count'), {signature: 'checkpoint', value: 1});
    assert.equal(journal.lookup('spawn:missing', 'missing'), undefined);
    assert.throws(() => journal!.lookup('spawn:one', 'changed'), /Stage label reused for a different task/);
  } finally { await journal?.close(); await rm(directory, {recursive: true, force: true}); }
});

test('journal checkpoint stage cap rejects without poisoning later writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-checkpoint-cap-'));
  const journal = await WorkflowJournal.open(directory, 'a'.repeat(64));
  try {
    await assert.rejects(journal.checkpoint('checkpoint:big', 'x'.repeat(1024 * 1024)), {message: /checkpoint exceeds the 1 MiB/, retryable: false});
    assert.equal(journal.lookup('checkpoint:big'), undefined);
    await journal.checkpoint('checkpoint:small', 'fits');
    assert.equal(journal.lookup('checkpoint:small')?.value, 'fits');
  } finally { await journal.close(); await rm(directory, {recursive: true, force: true}); }
});

for (const [label, corrupt, error] of [
  ['malformed JSON', async (path: string) => writeFile(path, '{'), SyntaxError],
  ['invalid records', async (path: string) => writeFile(path, '{}'), /Invalid workflow journal/],
  ['oversized files', async (path: string) => writeFile(path, 'x'.repeat(1024 * 1024 + 1)), /journal exceeds limit/],
  ['non-regular files', async (path: string) => { await rm(path); await mkdir(path); }, /must be a regular file/],
] as const) test(`journal loading rejects ${label} and releases identity after failed load`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-corrupt-'));
  const identity = 'a'.repeat(64);
  const journal = await WorkflowJournal.open(directory, identity);
  try {
    await journal.checkpoint('checkpoint:one', 1);
    await journal.close();
    const journalPath = join(directory, (await readdir(directory))[0]);
    const path = join(journalPath, (await readdir(journalPath))[0]);
    await corrupt(path);
    await assert.rejects(WorkflowJournal.open(directory, identity), error);
    await assert.rejects(WorkflowJournal.open(directory, identity), error);
  } finally { await journal.close(); await rm(directory, {recursive: true, force: true}); }
});

test('journal ownership rejects concurrent identical runs across directories before pruning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-exclusive-'));
  const directory = join(root, 'first'), otherDirectory = join(root, 'second');
  const identity = 'a'.repeat(64), staleIdentity = 'b'.repeat(64);
  const journal = await WorkflowJournal.open(directory, identity);
  try {
    const stale = await WorkflowJournal.open(otherDirectory, staleIdentity);
    await stale.checkpoint('checkpoint:one', 1);
    await stale.close();
    const path = join(otherDirectory, (await readdir(otherDirectory))[0]);
    await age(path, 30 * day);
    await assert.rejects(WorkflowJournal.open(directory, identity), /Identical workflow is already running/);
    await assert.rejects(WorkflowJournal.open(otherDirectory, identity), /Identical workflow is already running/);
    assert.deepEqual(await readdir(otherDirectory), [staleIdentity]);
    await journal.close();
    const resumed = await WorkflowJournal.open(directory, identity);
    await journal.close();
    await assert.rejects(WorkflowJournal.open(directory, identity), /already running/);
    await resumed.close();
  } finally { await journal.close(); await rm(root, {recursive: true, force: true}); }
});

test('journal reservation release admits waiting effects and abort rejects waiting stages and checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-reservations-'));
  const controller = new AbortController();
  const journal = await WorkflowJournal.open(directory, 'a'.repeat(64), {signal: controller.signal});
  const gate = () => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    return {promise, resolve, reject};
  };
  const gates = Array.from({length: 32}, gate);
  let running = 0, waitingStarted = false;
  const pending = gates.map((gate, i) => journal.record(`spawn:s${i}`, `task-${i}`, async () => { running++; await gate.promise; return 'small'; }));
  const failedFirst = assert.rejects(pending[0], /synthetic failure/);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(running, 32);
    const abortGate = gate();
    const waiting = journal.record('spawn:waiting', 'waiting', async () => { waitingStarted = true; await abortGate.promise; return 'small'; });
    const checkpoint = journal.checkpoint('checkpoint:waiting', 'fits');
    const checkpointAborted = assert.rejects(checkpoint, /abort/i);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(waitingStarted, false);
    assert.equal(journal.lookup('checkpoint:waiting'), undefined);
    gates[0].reject(new Error('synthetic failure'));
    await failedFirst;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(waitingStarted, true);
    assert.equal(journal.lookup('checkpoint:waiting'), undefined);
    const blocked = journal.record('spawn:aborted', 'aborted', async () => { throw new Error('must never run'); });
    const aborted = assert.rejects(blocked, /abort/i);
    controller.abort();
    await aborted;
    await checkpointAborted;
    abortGate.resolve();
    await waiting;
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
    await journal.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('journal on-disk compatibility pins version-2 bytes, filenames, ignored temps, total cap and idle-only legacy pruning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-format-'));
  const identity = 'a'.repeat(64), path = join(directory, identity);
  const filename = 'dd6a98c940ba0d55a10911e2678ec3ad6c6482d759ea512117cba791ae60ff6a.json';
  const golden = '{"version":2,"identity":"' + identity + '","key":"checkpoint:one","signature":"checkpoint","value":1}';
  let journal: WorkflowJournal | undefined;
  try {
    await mkdir(path, {mode: 0o700});
    await writeFile(join(path, filename), golden, {mode: 0o600});
    await writeFile(join(path, `${filename}.00000000-0000-0000-0000-000000000000.tmp`), 'x'.repeat(1024 * 1024 + 1));
    journal = await WorkflowJournal.open(directory, identity);
    assert.deepEqual(journal.keys, ['checkpoint:one']);
    assert.equal(journal.lookup('checkpoint:one')?.value, 1);
    await journal.close();
    await rm(path, {recursive: true});
    journal = await WorkflowJournal.open(directory, identity);
    await journal.checkpoint('checkpoint:one', 1);
    assert.equal(await readFile(join(path, filename), 'utf8'), golden);
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(path, filename))).mode & 0o777, 0o600);

    const legacy = Array.from({length: 17}, (_, n) => join(directory, `${n.toString(16).padStart(64, '0')}.json`));
    for (const file of legacy) await writeFile(file, '{}');
    const activeLegacy = join(directory, `${identity}.json`);
    await writeFile(activeLegacy, '{}');
    await age(activeLegacy, 8 * day);
    const legacyTemp = `${legacy[0]}.00000000-0000-0000-0000-000000000000.tmp`;
    await writeFile(legacyTemp, '{}');
    await age(legacy[0], 3 * hour);
    await age(legacyTemp, 3 * hour);
    const idleIdentity = 'b'.repeat(64);
    const idle = await WorkflowJournal.open(directory, idleIdentity);
    await idle.checkpoint('checkpoint:one', 1);
    await idle.close();
    await age(join(directory, idleIdentity), 3 * hour);
    const prune = await WorkflowJournal.open(directory, 'c'.repeat(64));
    await prune.close();
    assert.ok((await readdir(directory)).includes(idleIdentity), 'legacy files take no retention slot');
    await assert.rejects(stat(legacy[0]), {code: 'ENOENT'});
    await assert.rejects(stat(legacyTemp), {code: 'ENOENT'});
    await stat(activeLegacy);
    for (const file of legacy.slice(1)) await stat(file);
    await journal.close();
    const pruneAgain = await WorkflowJournal.open(directory, 'c'.repeat(64));
    await pruneAgain.close();
    await assert.rejects(stat(activeLegacy), {code: 'ENOENT'});

    await rm(path, {recursive: true});
    await mkdir(path);
    for (let i = 0; i < 33; i++) {
      const key = `checkpoint:pad${i}`;
      const record = JSON.stringify({version: 2, identity, key, signature: 'checkpoint', value: 'x'.repeat(1024 * 1024 - 1024)});
      await writeFile(join(path, `${createHash('sha256').update(key).digest('hex')}.json`), record);
    }
    await assert.rejects(WorkflowJournal.open(directory, identity), /journal exceeds limit/);
  } finally { await journal?.close(); await rm(directory, {recursive: true, force: true}); }
});

test('journal replay order uses modification time then key and preserves undefined values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-order-'));
  const identity = 'a'.repeat(64);
  let journal = await WorkflowJournal.open(directory, identity);
  try {
    await journal.record('spawn:z', 'z', async () => undefined);
    await journal.record('spawn:a', 'a', async () => 'a');
    await journal.record('spawn:old', 'old', async () => 'old');
    await journal.close();
    const path = join(directory, (await readdir(directory))[0]);
    const now = Date.now();
    for (const name of await readdir(path)) {
      const file = join(path, name);
      const record = JSON.parse(await readFile(file, 'utf8'));
      const time = new Date(now - (record.key === 'spawn:old' ? 2 * hour : hour));
      await utimes(file, time, time);
    }
    journal = await WorkflowJournal.open(directory, identity);
    assert.deepEqual(journal.keys, ['spawn:old', 'spawn:a', 'spawn:z']);
    assert.deepEqual(journal.lookup('spawn:z', 'z'), {signature: 'z', value: undefined});
  } finally { await journal.close(); await rm(directory, {recursive: true, force: true}); }
});

test('journal persistence failure reports before rejection, stays poisoned and close releases identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-write-failure-'));
  const directory = join(root, 'journals'), identity = 'a'.repeat(64);
  const errors: Error[] = [];
  const journal = await WorkflowJournal.open(directory, identity, {onFailure: error => errors.push(error)});
  try {
    await rm(directory, {recursive: true});
    await assert.rejects(journal.record('spawn:first', 'first', async () => 'effect'), /persistence failed/);
    assert.equal(errors.length, 1);
    assert.equal(journal.lookup('spawn:first', 'first'), undefined);
    await assert.rejects(journal.checkpoint('checkpoint:later', 2), /persistence failed.*persistence failed/);
    assert.equal(errors.length, 2);
    await journal.close();
    const fresh = await WorkflowJournal.open(directory, identity);
    await fresh.close();
  } finally { await journal.close(); await rm(root, {recursive: true, force: true}); }
});

test('journal retention expires stale journals even below the count limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-age-'));
  const staleIdentity = 'a'.repeat(64), recentIdentity = 'b'.repeat(64);
  try {
    for (const identity of [staleIdentity, recentIdentity]) {
      const journal = await WorkflowJournal.open(directory, identity);
      await journal.checkpoint('checkpoint:one', 1);
      await journal.close();
    }
    await age(join(directory, staleIdentity), 8 * day);
    await age(join(directory, recentIdentity), 3 * day);
    const journal = await WorkflowJournal.open(directory, 'c'.repeat(64));
    await journal.close();
    assert.deepEqual(await readdir(directory), [recentIdentity]);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
