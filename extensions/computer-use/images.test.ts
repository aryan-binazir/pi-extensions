import test from 'node:test';
import assert from 'node:assert/strict';
import { getImageDimensions } from '@earendil-works/pi-tui';
import { boundImages } from './images.ts';
import { png, pngHeader } from '../../tests/fixtures/png.ts';

const image = (bytes: Buffer, mimeType = 'image/png') => ({ type: 'image' as const, data: bytes.toString('base64'), mimeType });

test('oversized screenshots are downscaled to 2000 pixels with a coordinate note', async () => {
  const [bounded, note] = await boundImages([image(png(3000, 1500))]);
  assert.equal(bounded.type, 'image');
  assert.deepEqual(getImageDimensions(bounded.data, bounded.mimeType), { widthPx: 2000, heightPx: 1000 });
  assert.equal(note.type, 'text');
  assert.match(note.text, /original 3000x1500, displayed at 2000x1000\. Multiply coordinates by 1\.50/);
});

test('an image that cannot be processed is omitted with a note while text and other images survive', async () => {
  const good = image(png(40, 20));
  const result = await boundImages([{ type: 'text', text: 'accessibility tree' }, image(pngHeader(3000, 1500)), good]);
  assert.deepEqual(result.map(block => block.type), ['text', 'text', 'image']);
  assert.equal(result[0].type === 'text' && result[0].text, 'accessibility tree');
  assert.match(result[1].type === 'text' ? result[1].text : '', /Screenshot omitted: the image could not be processed/);
  assert.deepEqual(result[2], good);
});

test('a screenshot within 2000 pixels but over the 4.5 MB encoded limit is re-encoded below it', async () => {
  const noisy = image(png(1400, 1400, { noise: true }));
  assert.ok(noisy.data.length > 4_718_592, 'fixture must exceed the encoded limit');
  const [bounded] = await boundImages([noisy]);
  assert.equal(bounded.type, 'image');
  assert.ok(bounded.type === 'image' && bounded.data.length < 4_718_592);
});

test("the active model's tighter resize limits apply on the first pass", async () => {
  const [bounded, note] = await boundImages([image(png(3000, 1500))], { maxWidth: 1000, maxHeight: 1000 });
  assert.ok(bounded.type === 'image');
  assert.deepEqual(getImageDimensions(bounded.data, bounded.mimeType), { widthPx: 1000, heightPx: 500 });
  assert.match(note.type === 'text' ? note.text : '', /displayed at 1000x500\. Multiply coordinates by 3\.00/);
});

test('an aborted request stops before processing further images', async () => {
  const control = new AbortController(); control.abort(new Error('request aborted'));
  await assert.rejects(boundImages([image(png(3000, 1500))], undefined, control.signal), /request aborted/);
});

test('small real JPEG and WebP screenshots pass through unchanged without a note', async () => {
  const jpeg = { type: 'image' as const, mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAUUYf//Z' };
  const webp = { type: 'image' as const, mimeType: 'image/webp', data: 'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+7nZ//q0PlofLQ/c+/+QWlct3YAAA' };
  assert.deepEqual(await boundImages([jpeg, webp]), [jpeg, webp]);
});
