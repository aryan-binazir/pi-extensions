import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getImageDimensions } from '@earendil-works/pi-tui';
import computerUse from './index.ts';
import { pngResult } from './native.ts';
import { png } from '../../tests/fixtures/png.ts';

const register = () => {
  const handlers = new Map<string, () => Promise<void>>(); const tools: any[] = [];
  computerUse({ on(name: string, handler: any) { handlers.set(name, handler); }, registerTool(tool: any) { tools.push(tool); } } as any);
  return { handlers, tools };
};

test('every registered desktop tool is sequential and closed to unknown parameters', () => {
  const { tools } = register();
  assert.ok(tools.every(tool => tool.executionMode === 'sequential'));
  assert.ok(tools.every(tool => tool.parameters.additionalProperties === false));
});

test('Linux registers five desktop tools and keeps click coordinates normalized', { skip: process.platform === 'darwin' }, () => {
  const { tools } = register();
  assert.deepEqual(tools.map(tool => tool.name), ['computer_screenshot', 'computer_accessibility', 'computer_click', 'computer_type', 'computer_scroll']);
  assert.equal(tools.find(tool => tool.name === 'computer_click').parameters.properties.x.maximum, 1);
});

test('screenshot rejects invalid output and retains PNG dimensions', () => {
  assert.throws(() => pngResult(Buffer.from('not an image'), 'test'), /invalid/);
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=', 'base64');
  const result = pngResult(pixel, 'HEADLESS-1'); assert.equal(result.width, 1); assert.equal(result.height, 1); assert.equal(result.output, 'HEADLESS-1');
});

test('session shutdown blocks further desktop use', async () => {
  const { handlers, tools } = register();
  const accessibility = tools.find(tool => tool.name === 'computer_accessibility');
  await handlers.get('session_shutdown')!();
  await assert.rejects(accessibility.execute('closed', { app: 'fixture' }), /session closed/);
});

test('a new session restores desktop use after shutdown', { skip: process.platform !== 'linux' }, async () => {
  const { handlers, tools } = register();
  const accessibility = tools.find(tool => tool.name === 'computer_accessibility');
  await handlers.get('session_shutdown')!();
  await handlers.get('session_start')!();
  assert.equal((await accessibility.execute('new', {})).details.available, false);
  await handlers.get('session_shutdown')!();
});

const ints = (...n: number[]) => { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const string = (s: string) => { const b = Buffer.alloc(Math.ceil((Buffer.byteLength(s) + 1) / 4) * 4); b.write(s); return Buffer.concat([ints(Buffer.byteLength(s) + 1), b]); };
const msg = (id: number, op: number, body: Buffer) => Buffer.concat([ints(id, ((body.length + 8) << 16) | op), body]);

test('Linux screenshots reach Pi bounded to the active model image limits', { skip: process.platform !== 'linux' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-screenshot-')), socket = join(dir, 'wayland-test');
  const compositor = createServer(s => {
    let buffer = Buffer.alloc(0);
    s.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 8) {
        const id = buffer.readUInt32LE(0), word = buffer.readUInt32LE(4), size = word >>> 16, op = word & 65535;
        if (buffer.length < size) break;
        const body = Buffer.from(buffer.subarray(8, size)); buffer = buffer.subarray(size);
        if (id === 1 && op === 1) s.write(msg(body.readUInt32LE(0), 0, Buffer.concat([ints(11), string('wl_output'), ints(4)])));
        else if (id === 1 && op === 0) s.write(msg(body.readUInt32LE(0), 0, ints(42)));
        else if (id === 2 && op === 0) s.write(msg(body.readUInt32LE(body.length - 4), 4, string('HEADLESS-1')));
      }
    });
  });
  await new Promise<void>(resolve => compositor.listen(socket, resolve));
  await writeFile(join(dir, 'screen.png'), png(3000, 1500));
  await writeFile(join(dir, 'grim'), `#!/bin/sh\ncat '${join(dir, 'screen.png')}'\n`, { mode: 0o755 });
  const saved = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, PATH: process.env.PATH };
  process.env.WAYLAND_DISPLAY = socket; process.env.PATH = `${dir}:${process.env.PATH}`;
  const { handlers, tools } = register();
  t.after(async () => {
    await handlers.get('session_shutdown')!();
    Object.assign(process.env, saved); if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY;
    await new Promise(resolve => compositor.close(resolve)); await rm(dir, { recursive: true, force: true });
  });
  const model = { inputLimits: { images: { resize: { maxWidth: 1000, maxHeight: 1000 } } } };
  const { content, details } = await tools.find(tool => tool.name === 'computer_screenshot').execute('shot', {}, undefined, undefined, { model });
  const image = content.find((block: any) => block.type === 'image');
  assert.deepEqual(getImageDimensions(image.data, image.mimeType), { widthPx: 1000, heightPx: 500 });
  assert.equal(details.output, 'HEADLESS-1');
  assert.ok(content.some((block: any) => block.type === 'text' && /original 3000x1500, displayed at 1000x500/.test(block.text)));
});
