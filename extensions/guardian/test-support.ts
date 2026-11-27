import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, type TestContext } from 'node:test';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import { detectPlatformSandbox } from './sandbox.ts';

export const FLOCK_CANDIDATES = ['/usr/bin/flock', '/bin/flock'];
export const flock = FLOCK_CANDIDATES.find(existsSync);

/** Points `TMPDIR`, and so the shared synthetic-mount registry, at a private directory for the rest of this test file. */
export function isolateRegistryTmpdir(prefix: string): void {
  const registryTemp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = registryTemp;
  after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    rmSync(registryTemp, { recursive: true, force: true });
  });
}

/** Detection caches by cwd and reads `TMPDIR`, so call it after {@link isolateRegistryTmpdir}. */
export async function detectSandbox() {
  const detected = (await detectPlatformSandbox()).sandbox;
  const sandboxed = { skip: (!detected || (detected.kind === 'bubblewrap' && !flock)) && 'sandbox/flock prerequisites are unavailable' };
  return { detected, sandboxed };
}

export function canonicalTempDir(t: TestContext, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Holds the registry's flock(1) lock from another process until the returned release runs or the test ends. */
export async function holdRegistryLock(t: TestContext, registry: string) {
  mkdirSync(registry, { recursive: true });
  const child = spawn(flock!, ['--exclusive', join(registry, 'lock'), '/bin/sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  const closed = once(child, 'close');
  const release = async () => { child.stdin.end(); await closed; };
  t.after(release);
  return release;
}

export const WORKSPACE_CONFIG: GuardianConfig = { ...DEFAULT_GUARDIAN_CONFIG, sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'workspace-write' } };

/** Workspace-write with `/tmp` and `$TMPDIR` excluded, so writes stay inside the roots a test names. */
export const isolatedConfig = (overrides: Partial<GuardianConfig> = {}): GuardianConfig => ({
  ...WORKSPACE_CONFIG, ...overrides,
  sandbox: { ...WORKSPACE_CONFIG.sandbox, excludeSlashTmp: true, excludeTmpdirEnvVar: true, ...overrides.sandbox },
});
