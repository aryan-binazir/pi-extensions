import { createConnection, type Socket } from 'node:net';
import { endianness } from 'node:os';

// This client uses only protocols without file descriptors. All wire objects stay
// session-local; wl_display.sync proves processing, not application-side success.
const ints = (...values: number[]) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const waylandString = (value: string) => { const b = Buffer.alloc(Math.ceil((Buffer.byteLength(value) + 1) / 4) * 4); b.write(value); return Buffer.concat([ints(Buffer.byteLength(value) + 1), b]); };
function readString(b: Buffer, offset: number) {
  if (offset + 4 > b.length) throw new Error('Invalid Wayland string');
  const size = b.readUInt32LE(offset); const end = offset + 4 + size;
  if (!size || end > b.length || b[end - 1] !== 0) throw new Error('Invalid Wayland string');
  return { value: b.toString('utf8', offset + 4, end - 1), end: offset + 4 + Math.ceil(size / 4) * 4 };
}
export class WaylandPointer {
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private id = 3;
  private manager?: number;
  private managerVersion = 0;
  private ready?: Promise<void>;
  private error?: Error;
  private readonly globals: { name: number; iface: string; version: number }[] = [];
  private readonly outputIds = new Map<number, string>();
  private readonly pointers = new Map<string, number>();
  private readonly waiting = new Map<number, { resolve(): void; reject(error: Error): void }>();
  constructor(private readonly path: string) {}
  private fail(error: Error) { this.error ??= error; this.socket?.destroy(); for (const waiter of this.waiting.values()) waiter.reject(error); this.waiting.clear(); }
  close() { this.fail(new Error('Wayland connection closed')); }
  private send(id: number, opcode: number, body = Buffer.alloc(0)) {
    if (this.error) throw this.error;
    if (!this.socket || this.socket.destroyed) throw new Error('Wayland display unavailable');
    this.socket.write(Buffer.concat([ints(id, ((body.length + 8) << 16) | opcode), body]));
  }
  private async sync() {
    const id = this.id++;
    await new Promise<void>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.send(1, 0, ints(id)); } catch (error) { this.waiting.delete(id); reject(error); }
    });
  }
  private data(data: Buffer) {
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 1024 * 1024) throw new Error('Wayland event buffer limit');
      while (this.buffer.length >= 8) {
        const object = this.buffer.readUInt32LE(0), word = this.buffer.readUInt32LE(4), size = word >>> 16, opcode = word & 65535;
        if (size < 8 || size % 4) throw new Error('Invalid Wayland event frame');
        if (this.buffer.length < size) return;
        const body = this.buffer.subarray(8, size); this.buffer = this.buffer.subarray(size);
        if (object === 1 && opcode === 0) throw new Error('Wayland compositor rejected the protocol request');
        if (this.waiting.has(object) && opcode === 0) { this.waiting.get(object)!.resolve(); this.waiting.delete(object); }
        else if (object === 2 && opcode === 0) {
          const name = body.readUInt32LE(0), iface = readString(body, 4);
          this.globals.push({ name, iface: iface.value, version: body.readUInt32LE(iface.end) });
          if (this.globals.length > 1000) throw new Error('Wayland registry limit');
        } else if (object === 2 && opcode === 1) {
          // Hotplug invalidates the coordinate map. Never silently choose another output.
          const name = body.readUInt32LE(0), index = this.globals.findIndex(global => global.name === name);
          const removed = index < 0 ? undefined : this.globals.splice(index, 1)[0];
          if (removed?.iface === 'wl_output') {
            this.fail(new Error('Wayland registry changed; inspect the desktop again'));
          }
        } else if (this.outputIds.has(object) && opcode === 4) this.outputIds.set(object, readString(body, 0).value);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid Wayland event')); }
  }
  private async initialize() {
    if (endianness() !== 'LE') throw new Error('Wayland backend currently requires a little-endian host');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.path); this.socket = socket;
      socket.once('connect', resolve);
      socket.on('error', error => { reject(new Error('Wayland socket unavailable; check WAYLAND_DISPLAY and XDG_RUNTIME_DIR', { cause: error })); this.fail(error); });
      socket.on('close', () => this.fail(new Error('Wayland display disconnected')));
      socket.on('data', data => this.data(data));
    });
    this.send(1, 1, ints(2)); await this.sync();
    for (const global of this.globals) {
      if (global.iface === 'zwlr_virtual_pointer_manager_v1') {
        this.manager = this.id++; this.managerVersion = Math.min(global.version, 2);
        this.send(2, 0, Buffer.concat([ints(global.name), waylandString(global.iface), ints(this.managerVersion, this.manager)]));
      } else if (global.iface === 'wl_output' && global.version >= 4) {
        const id = this.id++; this.outputIds.set(id, '');
        this.send(2, 0, Buffer.concat([ints(global.name), waylandString(global.iface), ints(4, id)]));
      }
    }
    await this.sync();
  }
  private async withSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted(); const abort = () => this.fail(new Error('Wayland request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    try { this.ready ??= this.initialize(); await this.ready; signal.throwIfAborted(); return await operation(); }
    finally { signal.removeEventListener('abort', abort); }
  }
  outputs(signal: AbortSignal) {
    return this.withSignal(signal, async () => {
      if (this.error) throw this.error;
      return [...this.outputIds.values()].filter(Boolean);
    });
  }
  private async pointer(output: string) {
    const existing = this.pointers.get(output); if (existing) return existing;
    if (!this.manager || this.managerVersion < 2) throw new Error('Compositor lacks virtual-pointer v2; pointer control unavailable');
    const id = [...this.outputIds].find(([, name]) => name === output)?.[0];
    if (!id) throw new Error('Unknown or removed Wayland output; take a new screenshot');
    const pointer = this.id++; this.send(this.manager, 2, ints(0, id, pointer)); this.pointers.set(output, pointer);
    // Creating the first device announces wl_seat pointer capability. Let the
    // compositor process that before sending events to its clients.
    await this.sync(); return pointer;
  }
  click(output: string, x: number, y: number, button: 'left'|'right'|'middle', signal: AbortSignal) {
    return this.withSignal(signal, async () => {
      const pointer = await this.pointer(output), time = Date.now() >>> 0, code = { left: 272, right: 273, middle: 274 }[button];
      // Send down/up together; cancellation must never leave a deliberately held button.
      this.send(pointer, 1, ints(time, Math.min(999_999, Math.round(x * 1_000_000)), Math.min(999_999, Math.round(y * 1_000_000)), 1_000_000, 1_000_000));
      this.send(pointer, 4); await this.sync();
      signal.throwIfAborted();
      this.send(pointer, 2, ints(time, code, 1)); this.send(pointer, 4);
      this.send(pointer, 2, ints(time, code, 0)); this.send(pointer, 4); await this.sync();
    });
  }
  scroll(output: string, dx: number, dy: number, signal: AbortSignal) {
    return this.withSignal(signal, async () => {
      const pointer = await this.pointer(output), time = Date.now() >>> 0;
      if (dy) this.send(pointer, 3, ints(time, 0, Math.round(dy * 256)));
      if (dx) this.send(pointer, 3, ints(time, 1, Math.round(dx * 256)));
      this.send(pointer, 4); await this.sync();
    });
  }
}
