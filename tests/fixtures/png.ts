import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(kind: string, data: Buffer) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8);
  let crc = 0xffffffff;
  for (const byte of b.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4); return b;
}

/** PNG signature and IHDR only: a valid header whose pixels cannot be decoded. */
export function pngHeader(width: number, height: number) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)]);
}

/** Complete RGB PNG; `noise` fills it with deterministic incompressible pixels. */
export function png(width: number, height: number, { noise = false } = {}) {
  const stride = width * 3 + 1, rows = Buffer.alloc(stride * height);
  if (noise) {
    let seed = 42;
    for (let i = 0; i < rows.length; i++) {
      if (i % stride === 0) continue;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; rows[i] = seed >>> 24;
    }
  }
  return Buffer.concat([pngHeader(width, height), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
