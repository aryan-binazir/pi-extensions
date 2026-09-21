import test from 'node:test';
import assert from 'node:assert/strict';
import computerUse from './index.ts';
import { pngResult, LinuxDesktop } from './native.ts';

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
