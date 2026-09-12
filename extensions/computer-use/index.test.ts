import test from 'node:test';
import assert from 'node:assert/strict';
import computerUse from './index.ts';
import { pngResult, LinuxDesktop } from './native.ts';

test('all five tools register with sequential execution and preserve screenshot intent', () => {
  const tools: any[] = [];
  computerUse({ on() {}, registerTool(tool: any) { tools.push(tool); } } as any);
  assert.deepEqual(tools.map(t => t.name), ['computer_screenshot', 'computer_accessibility', 'computer_click', 'computer_type', 'computer_scroll']);
  assert.ok(tools.every(t => t.executionMode === 'sequential'));
  assert.equal(tools[2].parameters.properties.x.maximum, 1);
});

test('Linux accessibility reports unavailable without contacting desktop', async () => {
  const backend = new LinuxDesktop({});
  const result = await backend.run({ action: 'accessibility' }, new AbortController().signal);
  assert.equal(result.available, false); assert.equal(result.kind, 'accessibility'); backend.close();
});

test('screenshot rejects invalid output and retains PNG dimensions', () => {
  assert.throws(() => pngResult(Buffer.from('not an image'), 'test'), /invalid/);
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=', 'base64');
  const result = pngResult(pixel, 'HEADLESS-1'); assert.equal(result.width, 1); assert.equal(result.height, 1); assert.equal(result.output, 'HEADLESS-1');
});

test('macOS Swift helper typechecks without capturing or controlling desktop', { skip: process.platform !== 'darwin' }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  await promisify(execFile)('/usr/bin/swiftc', ['-typecheck', fileURLToPath(new URL('./macos.swift', import.meta.url))], { timeout: 60000, maxBuffer: 1024 * 1024 });
});

test('session shutdown blocks desktop use until a new session starts', async () => {
  const handlers = new Map<string, () => Promise<void>>(); const tools: any[] = [];
  computerUse({ on(name: string, handler: any) { handlers.set(name, handler); }, registerTool(tool: any) { tools.push(tool); } } as any);
  const accessibility = tools.find(tool => tool.name === 'computer_accessibility');
  await handlers.get('session_shutdown')!();
  await assert.rejects(accessibility.execute('closed', {}), /session closed/);
  await handlers.get('session_start')!();
  if (process.platform === 'linux') assert.equal((await accessibility.execute('new', {})).details.available, false);
  await handlers.get('session_shutdown')!();
});

test('Mac shutdown during setup cannot start a late helper', async () => {
  const { MacDesktop } = await import('./native.ts');
  const backend = new MacDesktop();
  const operation = backend.run({ action: 'screenshot' }, new AbortController().signal);
  const rejected = assert.rejects(operation, /session closed/);
  await backend.close(); await rejected;
});
