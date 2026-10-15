import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pngResult } from './native.ts';

function png(width: number, height: number, busy = false) {
  const chunk = (kind: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8);
    let crc = 0xffffffff;
    for (const byte of b.subarray(4, -4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4); return b;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  if (busy) {
    let seed = 42;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      rows[i] = (x >> 4) % 256; rows[i + 1] = (y >> 3) % 256; rows[i + 2] = (seed >>> 24) & 63;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('large screenshots fit within 2000 pixels and retain output-relative coordinates', async () => {
  const result = await pngResult(png(3840, 2160), 'HEADLESS-1');
  assert.equal(result.width, 2000); assert.equal(result.height, 1125);
  assert.equal(result.output, 'HEADLESS-1');
  assert.equal(result.originalWidth, 3840); assert.equal(result.originalHeight, 2160);
  assert.equal(result.coordinates, 'Click x/y are fractions from 0 to 1 within this output.');
  const bytes = Buffer.from(result.image!, 'base64');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(bytes.readUInt32BE(16), 2000); assert.equal(bytes.readUInt32BE(20), 1125);
});

test('small screenshots pass through byte-for-byte without upscaling', async () => {
  const bytes = png(1280, 720), result = await pngResult(bytes, 'HEADLESS-1');
  assert.equal(result.image, bytes.toString('base64')); assert.equal(result.mimeType, 'image/png');
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
});

test('portrait screenshots are bounded by height', async () => {
  const result = await pngResult(png(2160, 3840), 'HEADLESS-1');
  assert.equal(result.width, 1125); assert.equal(result.height, 2000);
});

test('screenshots at the dimension limit pass through unchanged', async () => {
  const bytes = png(2000, 1125), result = await pngResult(bytes, 'HEADLESS-1');
  assert.equal(result.image, bytes.toString('base64'));
});

test('large PNG headers with undecodable pixels do not return an unbounded image', async () => {
  const bytes = png(3840, 2160).subarray(0, 33);
  await assert.rejects(pngResult(bytes, 'HEADLESS-1'), /could not be resized/);
});


test('busy large screenshots carry the JPEG format selected by Pi', async () => {
  const result = await pngResult(png(3840, 2160, true), 'HEADLESS-1');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(result.image!, 'base64').subarray(0, 3), Buffer.from([255, 216, 255]));
  assert.equal(result.width, 2000); assert.equal(result.height, 1125);
});
