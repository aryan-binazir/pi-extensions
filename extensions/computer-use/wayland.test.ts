import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WaylandPointer } from './wayland.ts';

const ints = (...n: number[]) => { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const string = (s: string) => { const b = Buffer.alloc(Math.ceil((Buffer.byteLength(s) + 1) / 4) * 4); b.write(s); return Buffer.concat([ints(Buffer.byteLength(s) + 1), b]); };
const msg = (id: number, op: number, body: Buffer) => Buffer.concat([ints(id, ((body.length + 8) << 16) | op), body]);

test('real Unix wire transport discovers output, binds pointer to it, clicks and scrolls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wayland-')); const socket = join(dir, 'wayland-test');
  let removeGlobal: number | undefined;
  let onDisconnect!: () => void;
  const disconnected = new Promise<void>(resolve => { onDisconnect = resolve; });
  const requests: { id: number; op: number; body: Buffer }[] = [];
  const server = createServer(s => {
    s.once('close', onDisconnect);
    let buffer = Buffer.alloc(0);
    s.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 8) {
        const id = buffer.readUInt32LE(0), word = buffer.readUInt32LE(4), size = word >>> 16, op = word & 65535;
        if (buffer.length < size) break;
        const body = Buffer.from(buffer.subarray(8, size)); buffer = buffer.subarray(size); requests.push({ id, op, body });
        if (id === 1 && op === 1) {
          const registry = body.readUInt32LE(0);
          s.write(msg(registry, 0, Buffer.concat([ints(10), string('zwlr_virtual_pointer_manager_v1'), ints(2)])));
          s.write(msg(registry, 0, Buffer.concat([ints(11), string('wl_output'), ints(4)])));
          s.write(msg(registry, 0, Buffer.concat([ints(12), string('wl_seat'), ints(7)])));
        } else if (id === 1 && op === 0) {
          if (removeGlobal !== undefined) { s.write(msg(2, 1, ints(removeGlobal))); removeGlobal = undefined; }
          s.write(msg(body.readUInt32LE(0), 0, ints(42)));
        } else if (id === 2 && op === 0 && body.readUInt32LE(0) === 11) {
          const output = body.readUInt32LE(body.length - 4); s.write(msg(output, 4, string('HEADLESS-1')));
        }
      }
    });
  });
  await new Promise<void>(r => server.listen(socket, r));
  const pointer = new WaylandPointer(socket);
  try {
    assert.deepEqual(await pointer.outputs(new AbortController().signal), ['HEADLESS-1']);
    await pointer.click('HEADLESS-1', .25, .5, 'left', new AbortController().signal);
    await pointer.scroll('HEADLESS-1', 0, -2, new AbortController().signal);
    await pointer.click('HEADLESS-1', 1, 1, 'left', new AbortController().signal);
    const absolute = requests.find(r => r.op === 1 && r.id > 2 && r.body.length === 20)!;
    assert.equal(absolute.body.readUInt32LE(4), 250000);
    const creation = requests.findIndex(r => r.op === 2 && r.body.length === 12 && r.body.readUInt32LE(0) === 0);
    const motion = requests.indexOf(absolute);
    const press = requests.findIndex(r => r.id === absolute.id && r.op === 2);
    assert.ok(requests.slice(creation + 1, motion).some(r => r.id === 1 && r.op === 0), 'device creation is acknowledged before movement');
    assert.ok(requests.slice(motion + 1, press).some(r => r.id === 1 && r.op === 0), 'movement is acknowledged before button events');
    const buttons = requests.filter(r => r.op === 2 && r.id === absolute.id && r.body.length === 12);
    assert.deepEqual(buttons.map(r => [r.body.readUInt32LE(4), r.body.readUInt32LE(8)]), [[272, 1], [272, 0], [272, 1], [272, 0]]);
    const edge = requests.filter(r => r.op === 1 && r.id === absolute.id).at(-1)!;
    assert.equal(edge.body.readUInt32LE(4), 999999);
    assert.equal(edge.body.readUInt32LE(8), 999999);
    const axis = requests.find(r => r.op === 3 && r.body.length === 12)!;
    assert.equal(axis.body.readInt32LE(8), -512);
    await t.test('unrelated global removal keeps the output usable', async () => {
      removeGlobal = 12;
      await pointer.click('HEADLESS-1', .25, .5, 'left', new AbortController().signal);
      assert.deepEqual(await pointer.outputs(new AbortController().signal), ['HEADLESS-1']);
    });
    await t.test('output global removal invalidates pointer operations', async () => {
      removeGlobal = 11;
      await assert.rejects(pointer.click('HEADLESS-1', .25, .5, 'left', new AbortController().signal), /Wayland registry changed/);
      await assert.rejects(pointer.outputs(new AbortController().signal), /Wayland registry changed/);
    });
    await t.test('disconnected connections retain the original output-removal error', async () => {
      await disconnected;
      await new Promise<void>(resolve => setImmediate(resolve));
      await assert.rejects(pointer.outputs(new AbortController().signal), /Wayland registry changed/);
    });
  } finally { pointer.close(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true }); }
});

test('invalid compositor frames fail promptly and close the socket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wayland-bad-')), path = join(dir, 'socket');
  let onDisconnect!: () => void;
  const disconnected = new Promise<void>(resolve => { onDisconnect = resolve; });
  const server = createServer(socket => { socket.once('close', onDisconnect); socket.resume(); socket.write(ints(1, 4 << 16)); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const pointer = new WaylandPointer(path);
  try {
    await assert.rejects(pointer.outputs(AbortSignal.timeout(1000)), /Invalid Wayland event frame/);
    await Promise.race([disconnected, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('socket stayed open')), 2000).unref())]);
  }
  finally { pointer.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true }); }
});
