import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { linuxSessionEnvironment } from './linux-session.ts';

test('explicit session values are preserved without discovery', () => {
  for (const env of [{ WAYLAND_DISPLAY: '/explicit/socket' }, { WAYLAND_DISPLAY: 'stale', XDG_RUNTIME_DIR: '/missing' }]) {
    assert.deepEqual(linuxSessionEnvironment(env), env);
    assert.notEqual(linuxSessionEnvironment(env), env);
  }
});

test('discovery requires one owned socket in a private runtime directory', async t => {
  const runtime = mkdtempSync(join(tmpdir(), 'pi-wl-'));
  const servers: ReturnType<typeof createServer>[] = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(runtime, { recursive: true, force: true });
  });
  const env = { XDG_RUNTIME_DIR: runtime, PATH: '/example' };
  assert.throws(() => linuxSessionEnvironment(env), /Wayland unavailable/);
  assert.throws(() => linuxSessionEnvironment({ XDG_RUNTIME_DIR: 'relative' }), /unavailable/);
  assert.throws(() => linuxSessionEnvironment({ XDG_RUNTIME_DIR: join(runtime, 'missing') }), /unavailable/);
  writeFileSync(join(runtime, 'wayland-0'), 'not a socket');
  const socket = async (name: string) => {
    const server = createServer(); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(runtime, name), resolve); });
  };
  await socket('wayland-1');
  symlinkSync(join(runtime, 'wayland-1'), join(runtime, 'wayland-link'));
  const resolved = linuxSessionEnvironment(env);
  assert.deepEqual(resolved, { ...env, WAYLAND_DISPLAY: 'wayland-1' });
  assert.equal('WAYLAND_DISPLAY' in env, false);
  assert.throws(() => linuxSessionEnvironment(env, process.getuid!() + 1), /unavailable/);
  chmodSync(runtime, 0o755);
  assert.throws(() => linuxSessionEnvironment(env), /unavailable/);
  chmodSync(runtime, 0o700);
  await socket('wayland-2');
  assert.throws(() => linuxSessionEnvironment(env), /ambiguous/);
  assert.equal(linuxSessionEnvironment({ ...env, WAYLAND_DISPLAY: 'wayland-1' }).WAYLAND_DISPLAY, 'wayland-1');
});
