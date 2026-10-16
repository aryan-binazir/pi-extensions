import { crc32, deflateSync } from 'node:zlib';

function chunk(kind: string, data: Buffer) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b;
}

export function pngHeader(width: number, height: number) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)]);
}

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
