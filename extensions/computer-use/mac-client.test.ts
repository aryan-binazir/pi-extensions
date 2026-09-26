import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approve, boundedText, macLaunch, macResult, MacSession } from './mac-client.ts';
import { registerMacTools } from './mac-tools.ts';

const fixture = () => ({ command: process.execPath, args: [fileURLToPath(new URL('../../tests/fixtures/computer-mcp.mjs', import.meta.url))], stderr: 'pipe' as const });
const ctx = (hasUI = false, answer = false): any => ({ hasUI, ui: { confirm: async () => answer } });
const request: any = { message: 'Allow ChatGPT to use Fixture?', requestedSchema: { type: 'object', properties: {} }, _meta: { persist: ['always'], riskLevel: 'high' } };

test('Mac discovery launches relay with official bundled Node and respects CODEX_HOME; never falls back', () => {
  const paths: string[] = [];
  const launch = macLaunch({ CODEX_HOME: '/custom-codex' }, '/fixture-home', path => { paths.push(path); return path.startsWith('/fixture-home/Applications/Codex.app/') || path.startsWith('/custom-codex/'); });
  assert.equal(launch.command, '/fixture-home/Applications/Codex.app/Contents/Resources/cua_node/bin/node');
  assert.match(launch.args![0], /mac-relay.mjs$/);
  assert.equal(launch.args![1], '/custom-codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
  assert.ok(paths.includes('/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'));
  assert.throws(() => macLaunch({}, '/fixture', () => false), /No native fallback/);
});

test('Mac surface is app targeted with pixel coordinates and explicit tools only', () => {
  const tools: any[] = [];
  registerMacTools({ on() {}, registerTool(tool: any) { tools.push(tool); } } as any);
  assert.equal(tools.length, 7);
  assert.ok(tools.every(tool => tool.executionMode === 'sequential'));
  const click = tools.find(tool => tool.name === 'computer_click');
  assert.ok(click.parameters.required.includes('app'));
  assert.ok(click.parameters.properties.mouse_button);
  assert.ok(click.parameters.properties.click_count);
  assert.equal(click.parameters.properties.button, undefined);
  assert.equal(click.parameters.properties.count, undefined);
  assert.ok(tools.find(tool => tool.name === 'computer_key'));
});

test('approval is explicit, nonpersistent, denies headless and unsupported forms, cancels even with an unresolved UI', async () => {
  const control = new AbortController();
  assert.deepEqual(await approve(request, ctx(), control.signal), { action: 'decline' });
  assert.deepEqual(await approve(request, ctx(true, false), control.signal), { action: 'decline' });
  assert.deepEqual(await approve(request, ctx(true, true), control.signal), { action: 'accept', content: {} });
  assert.deepEqual(await approve({ ...request, requestedSchema: { type: 'object', properties: { secret: { type: 'string' } } } }, ctx(true, true), control.signal), { action: 'decline' });
  let uiSignal: AbortSignal | undefined;
  const pending = approve(request, { hasUI: true, ui: { confirm: async (_title: string, text: string, options: any) => {
    assert.match(text, /riskLevel/); uiSignal = options.signal; return new Promise<boolean>(() => {});
  } } } as any, control.signal);
  control.abort();
  assert.deepEqual(await pending, { action: 'cancel' });
  assert.equal(uiSignal?.aborted, true);
});

test('bounded response conversion preserves genuine errors and rejects malformed images', () => {
  const text = 'é'.repeat(100000);
  assert.ok(Buffer.byteLength(boundedText(text)) <= 65536);
  assert.match(boundedText(text), /truncated/);
  const bounded = macResult({ content: Array.from({ length: 10 }, () => ({ type: 'text' as const, text })), structuredContent: { large: text }, _meta: { large: text } });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 66000);
  assert.equal(bounded.content.length, 1);
  assert.throws(() => macResult({ isError: true, content: [{ type: 'text', text: 'Actual service denial' }] }), /Actual service denial/);
  assert.throws(() => macResult({ content: [{ type: 'image', mimeType: 'text/html', data: 'AAAA' }] }), /Invalid/);
  assert.throws(() => macResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }), /Invalid/);
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=', 'base64').toString('base64');
  assert.equal(macResult({ content: [{ type: 'image', mimeType: 'image/png', data }] }).content[0].type, 'image');
  assert.equal(macResult({ content: [{ type: 'image', mimeType: 'image/png', data }] }, true).content.length, 0);
  assert.throws(() => macResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(24 * 1024 * 1024) }] }), /oversized/);
});

test('real SDK fixture connects lazily once, routes elicitation, preserves tool errors, enforces schemas and allowlist', async () => {
  let launches = 0;
  const session = new MacSession(() => { launches++; return fixture(); }, 5000);
  try {
    assert.equal(launches, 0);
    assert.match(JSON.stringify(await session.run('list_apps', {}, ctx())), /Fixture apps/);
    assert.match(JSON.stringify(await session.run('get_app_state', { app: 'fixture' }, ctx())), /decline/);
    assert.match(JSON.stringify(await session.run('get_app_state', { app: 'fixture' }, ctx(true, true))), /accept/);
    assert.equal(launches, 1);
    await assert.rejects(session.run('execute_code', {}, ctx()), /not allowed/);
    await assert.rejects(session.run('click', { app: 'error' }, ctx()), /Real fixture policy denial.*\nMutation outcome/s);
    assert.equal(launches, 1, 'failed mutation does not relaunch');
    await session.run('list_apps', {}, ctx());
    assert.equal(launches, 2, 'later inspection reconnects');
    await assert.rejects(session.run('click', { invented: true }, ctx()), /official click schema/);
  } finally { await session.close(); }
  await assert.rejects(session.run('list_apps', {}, ctx()), /session closed/);
});

test('cancellation closes an active SDK client before queued work reconnects', async () => {
  let launches = 0;
  const session = new MacSession(() => { launches++; return fixture(); }, 5000);
  try {
    await session.run('list_apps', {}, ctx());
    const control = new AbortController();
    const waiting = session.run('get_app_state', { app: 'wait' }, ctx(), control.signal);
    const rejected = assert.rejects(waiting, /abort/i);
    await new Promise(resolve => setTimeout(resolve, 50));
    const queued = session.run('list_apps', {}, ctx());
    control.abort(); await rejected;
    await queued; assert.equal(launches, 2);
  } finally { await session.close(); }
});

test('a request that outlives its deadline times out and the session still closes', async () => {
  const timeout = new MacSession(fixture, 30);
  try { await assert.rejects(timeout.run('get_app_state', { app: 'wait' }, ctx()), /timed out/); }
  finally { await timeout.close(); }
});

test('large JPEG observations survive conversion and are marked untrusted', () => {
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(300000), Buffer.from([255, 217])]);
  const result = macResult({ _meta: { subtitle: 'untrusted' }, content: [
    { type: 'text', text: 'state '.repeat(4000) },
    { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64'), _meta: { note: 'untrusted image' } },
  ] });
  assert.equal(result.content[1].type, 'image');
  assert.deepEqual(result.details, { source: 'Codex computer-use service', untrusted: true });
  assert.throws(() => macResult({ content: [{ type: 'resource_link', uri: 'https://example.invalid', name: 'unexpected' }] }), /unsupported/);
});

test('URL approval requests are denied without displaying a prompt', async () => {
  assert.deepEqual(await approve({ mode: 'url', message: 'Open URL', url: 'https://example.invalid', elicitationId: 'fixture' }, {
    hasUI: true, ui: { confirm() { throw new Error('must not prompt'); } },
  } as any, new AbortController().signal), { action: 'decline' });
});

test('image base64 is accepted exactly when it is the canonical encoding of its bytes', () => {
  const png = Buffer.alloc(4096);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write('IHDR', 12, 'ascii');
  for (let i = 24; i < png.length; i += 5) png[i] = i & 255;
  const accepts = (data: string) => { try { macResult({ content: [{ type: 'image', mimeType: 'image/png', data }] }); return true; } catch (error) { return !/Invalid image base64/.test((error as Error).message); } };
  const canonical = (data: string) => Buffer.from(data, 'base64').toString('base64') === data;
  const encoded = png.toString('base64');
  for (const data of [encoded, '', 'AAAA', 'AAA=', 'AB==', 'AQ==', 'A===', '====', 'QQ==QQ==', 'A'.repeat(5), '****', encoded + 'A', encoded.slice(0, -1), encoded + '==', encoded.slice(0, 8) + '*' + encoded.slice(9), encoded.slice(0, 8) + '=' + encoded.slice(9)]) {
    assert.equal(accepts(data), canonical(data), JSON.stringify(data.slice(0, 16)));
  }
  const bytesPerChunk = 3 * 65536;
  const charsPerChunk = (bytesPerChunk / 3) * 4;
  const wide = Buffer.alloc(bytesPerChunk * 2 + 9);
  for (let i = 0; i < wide.length; i += 3) wide[i] = i & 255;
  const big = wide.toString('base64');
  for (const at of [0, charsPerChunk - 1, charsPerChunk, charsPerChunk + 1, big.length - 2]) {
    const broken = big.slice(0, at) + (big[at] === 'A' ? 'B' : 'A') + big.slice(at + 1);
    assert.equal(accepts(broken), canonical(broken), 'boundary ' + at);
  }
});

test('bounded text truncates on real UTF-8 bytes, not code unit count', () => {
  assert.equal(boundedText('a'.repeat(65536)), 'a'.repeat(65536));
  assert.match(boundedText('a'.repeat(65537)), /\n\[truncated\]$/);
  assert.equal(boundedText('é'.repeat(32768)), 'é'.repeat(32768));
  const wide = 'é'.repeat(32769);
  assert.ok(wide.length <= 65536 && Buffer.byteLength(wide) > 65536);
  assert.ok(Buffer.byteLength(boundedText(wide)) <= 65536);
  assert.match(boundedText(wide), /\n\[truncated\]$/);
  assert.equal(boundedText('日'.repeat(21845)), '日'.repeat(21845));
  assert.match(boundedText('日'.repeat(21846)), /\n\[truncated\]$/);
});
