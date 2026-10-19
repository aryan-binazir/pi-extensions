// Ported from openai/codex codex-rs/linux-sandbox/src/linux_run_main_tests.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. Each test uses its own registry root instead of the shared one.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cleanupSyntheticMountTargets, existingTarget, hashPath, missingTarget, registerSyntheticMountTargets, shouldRemoveAfterBwrap,
  syntheticMountRegistryRoot,
} from './synthetic-mounts.ts';

function tempDir(t: test.TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-synthetic-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cleanup removes only empty mount targets', async t => {
  const dir = tempDir(t), registry = join(dir, 'registry');
  const emptyFile = join(dir, '.git'), emptyDir = join(dir, '.agents'), nonEmptyFile = join(dir, 'non-empty'), missingFile = join(dir, '.missing');
  writeFileSync(emptyFile, '');
  mkdirSync(emptyDir);
  writeFileSync(nonEmptyFile, 'keep');

  const registrations = await registerSyntheticMountTargets([
    missingTarget(emptyFile, 'empty-file'), missingTarget(emptyDir, 'empty-directory'),
    missingTarget(nonEmptyFile, 'empty-file'), missingTarget(missingFile, 'empty-file'),
  ], registry);
  await cleanupSyntheticMountTargets(registrations, registry);

  assert.equal(existsSync(emptyFile), false);
  assert.equal(existsSync(emptyDir), false);
  assert.equal(readFileSync(nonEmptyFile, 'utf8'), 'keep');
  assert.equal(existsSync(missingFile), false);
  assert.deepEqual(readdirSync(registry).filter(name => name !== 'lock'), [], 'marker directories are removed with their targets; the lock file stays, as in Codex');
});

test('the registry root is unique to the effective user and shared with Codex', () => {
  const root = syntheticMountRegistryRoot({ TMPDIR: tmpdir() });
  assert.equal(root, join(realpathSync(tmpdir()), `codex-bwrap-synthetic-mount-targets-${process.geteuid!()}`));
  assert.equal(syntheticMountRegistryRoot({}), join(realpathSync('/tmp'), `codex-bwrap-synthetic-mount-targets-${process.geteuid!()}`));
});

test('marker directories use Codex\'s FNV-1a path hash', () => {
  assert.equal(hashPath(''), 'cbf29ce484222325');
  assert.equal(hashPath('a'), 'af63dc4c8601ec8c');
  assert.equal(hashPath('/tmp/.git').length, 16);
});

test('cleanup waits for other active registrations', async t => {
  const dir = tempDir(t), registry = join(dir, 'registry');
  const emptyDir = join(dir, '.git');
  mkdirSync(emptyDir);
  const target = missingTarget(emptyDir, 'empty-directory');

  let registrations = await registerSyntheticMountTargets([target], registry);
  // PID 1 is always alive, standing in for another sandbox that still masks the path.
  const activeMarker = join(registrations[0].markerDir, '1');
  writeFileSync(activeMarker, '');
  await cleanupSyntheticMountTargets(registrations, registry);
  assert.equal(existsSync(emptyDir), true);

  unlinkSync(activeMarker);
  registrations = await registerSyntheticMountTargets([target], registry);
  await cleanupSyntheticMountTargets(registrations, registry);
  assert.equal(existsSync(emptyDir), false);
});

test('cleanup removes a transient file after its concurrent owner exits', async t => {
  const dir = tempDir(t), registry = join(dir, 'registry');
  const emptyFile = join(dir, '.git');
  const first = await registerSyntheticMountTargets([missingTarget(emptyFile, 'empty-file')], registry);
  writeFileSync(emptyFile, '');
  const activeMarker = join(first[0].markerDir, '1');
  writeFileSync(activeMarker, 'synthetic\n');
  const second = await registerSyntheticMountTargets([existingTarget(emptyFile, 'empty-file', lstatSync(emptyFile, { bigint: true }))], registry);

  await cleanupSyntheticMountTargets(first, registry);
  assert.equal(existsSync(emptyFile), true);

  unlinkSync(activeMarker);
  await cleanupSyntheticMountTargets(second, registry);
  assert.equal(existsSync(emptyFile), false);
});

test('cleanup preserves a real pre-existing empty file', async t => {
  const dir = tempDir(t), registry = join(dir, 'registry');
  const emptyFile = join(dir, '.git');
  writeFileSync(emptyFile, '');
  const stats = lstatSync(emptyFile, { bigint: true });

  const first = await registerSyntheticMountTargets([existingTarget(emptyFile, 'empty-file', stats)], registry);
  const second = await registerSyntheticMountTargets([existingTarget(emptyFile, 'empty-file', stats)], registry);
  await cleanupSyntheticMountTargets(first, registry);
  await cleanupSyntheticMountTargets(second, registry);

  assert.equal(existsSync(emptyFile), true);
});

test('overlapping registrations from this process keep the placeholder until the last one ends', async t => {
  const dir = tempDir(t), registry = join(dir, 'registry');
  const emptyDir = join(dir, '.codex');
  const first = await registerSyntheticMountTargets([missingTarget(emptyDir, 'empty-directory')], registry);
  mkdirSync(emptyDir);
  const second = await registerSyntheticMountTargets([existingTarget(emptyDir, 'empty-directory', lstatSync(emptyDir, { bigint: true }))], registry);
  assert.equal(second[0].target.preExisting, undefined, 'a live placeholder is not mistaken for a real directory');

  await cleanupSyntheticMountTargets(first, registry);
  assert.equal(existsSync(emptyDir), true);
  await cleanupSyntheticMountTargets(second, registry);
  assert.equal(existsSync(emptyDir), false);
});

test('a placeholder that was replaced or filled is not removed', t => {
  const dir = tempDir(t);
  const file = join(dir, 'file');
  writeFileSync(file, 'content');
  assert.equal(shouldRemoveAfterBwrap(missingTarget(file, 'empty-file'), lstatSync(file, { bigint: true })), false);
  assert.equal(shouldRemoveAfterBwrap(missingTarget(dir, 'empty-file'), lstatSync(dir, { bigint: true })), false);
  assert.equal(shouldRemoveAfterBwrap(missingTarget(file, 'empty-directory'), lstatSync(file, { bigint: true })), false);
});

test('a symlinked registry root is rejected', t => {
  const dir = tempDir(t);
  const root = join(dir, `codex-bwrap-synthetic-mount-targets-${process.geteuid!()}`);
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), root);
  assert.throws(() => syntheticMountRegistryRoot({ TMPDIR: dir }), /must not be a symlink/);
});
