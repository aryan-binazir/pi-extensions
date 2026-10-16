export const ints = (...n: number[]) => { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
export const string = (s: string) => { const b = Buffer.alloc(Math.ceil((Buffer.byteLength(s) + 1) / 4) * 4); b.write(s); return Buffer.concat([ints(Buffer.byteLength(s) + 1), b]); };
export const msg = (id: number, op: number, body: Buffer) => Buffer.concat([ints(id, ((body.length + 8) << 16) | op), body]);
