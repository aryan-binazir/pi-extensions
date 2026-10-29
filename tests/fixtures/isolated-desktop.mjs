#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ints, msg, string } from './wayland.ts';

const command = basename(process.argv[1]), runtime = process.env.XDG_RUNTIME_DIR;
const record = (name, value) => writeFileSync(join(runtime, name), JSON.stringify(value));
if (process.argv[2] === '--descendant') {
  record('descendant.json', { pid: process.pid });
  setInterval(() => {}, 1000);
} else if (command === 'chromium') {
  record('browser.json', { instance: randomUUID(), args: process.argv.slice(2), env: process.env });
  spawn('setsid', ['-f', process.execPath, new URL(import.meta.url).pathname, '--descendant', runtime], { stdio: 'ignore' }).once('error', error => { throw error; });
  setInterval(() => {}, 1000);
} else if (command === 'wtype') {
  const args = process.argv.slice(2);
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (args.includes('v')) {
    if (existsSync(join(runtime, 'wtype-fail'))) process.exit(7);
    text = JSON.parse(readFileSync(join(runtime, 'clipboard.json'), 'utf8')).text;
  }
  record('typed.json', { text, args, env: process.env });
} else if (command === 'wl-copy' || command === 'wl-paste') {
  const args = process.argv.slice(2);
  appendFileSync(join(runtime, 'clipboard-commands.jsonl'), JSON.stringify({ command, args, env: process.env }) + '\n');
  if (command === 'wl-paste') {
    const available = existsSync(join(runtime, 'clipboard.json'));
    record('clipboard-probed', {});
    if (existsSync(join(runtime, 'wl-paste-fail'))) {
      while (!existsSync(join(runtime, 'clipboard-started.json'))) await delay(5);
      process.stderr.write('fixture clipboard failure\n'); process.exit(7);
    }
    if (!available) { process.stderr.write('Nothing is copied\n'); process.exit(1); }
    if (args.length !== 1 || args[0] !== '--list-types') process.exit(8);
    process.stdout.write('text/plain;charset=utf-8\ntext/plain\n');
  } else if (args.includes('--clear')) {
    if (existsSync(join(runtime, 'wl-clear-fail'))) process.exit(7);
    for (const name of ['clipboard.json', 'clipboard-probed']) if (existsSync(join(runtime, name))) unlinkSync(join(runtime, name));
  } else {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    record('clipboard-started.json', { pid: process.pid, parent: process.ppid, text, args, env: process.env });
    if (existsSync(join(runtime, 'wl-copy-fail'))) process.exit(7);
    if (existsSync(join(runtime, 'clipboard-descendant'))) spawn(process.execPath, [new URL(import.meta.url).pathname, '--descendant'], { stdio: 'inherit' });
    while (!existsSync(join(runtime, 'clipboard-probed'))) await delay(5);
    while (existsSync(join(runtime, 'clipboard-wait'))) await delay(5);
    record('clipboard.json', { text });
    await new Promise(() => setInterval(() => {}, 1000));
  }
} else if (command === 'grim') {
  if (existsSync(join(runtime, 'grim-fail'))) { unlinkSync(join(runtime, 'grim-fail')); process.exit(1); }
  if (existsSync(join(runtime, 'grim-wait'))) { record('grim-started', {}); await new Promise(() => setInterval(() => {}, 1000)); }
  record('grim.json', { args: process.argv.slice(2), env: process.env });
  process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=', 'base64'));
} else if (command === 'sway') {
  let mode = '';
  try { mode = readFileSync(join(dirname(process.argv[1]), 'mode'), 'utf8'); } catch {}
  if (mode === 'noisy-fail') { process.stderr.write('fixture sway failure ' + 'x'.repeat(100000), () => process.exit(23)); await new Promise(() => {}); }
  writeFileSync(join(dirname(process.argv[1]), 'latest-runtime'), runtime);
  if (mode === 'fail') { process.stderr.write('fixture sway failed\n'); process.exit(23); }
  record('sway.json', { args: process.argv.slice(2), env: process.env });
  setInterval(() => {
    try { readFileSync(join(runtime, 'crash')); process.stderr.write('fixture desktop crashed\n', () => process.exit(31)); } catch {}
  }, 20);
  const browser = spawn('/bin/sh', [join(runtime, 'browser.sh')], { stdio: 'inherit' });
  browser.once('exit', code => process.exit(code ?? 1));
  browser.once('error', error => { process.stderr.write(error.message); process.exit(1); });
  if (mode === 'wait') setInterval(() => {}, 1000);
  else {
    const server = createServer(socket => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 8) {
          const id = buffer.readUInt32LE(0), word = buffer.readUInt32LE(4), size = word >>> 16, op = word & 65535;
          if (buffer.length < size) break;
          const body = Buffer.from(buffer.subarray(8, size)); buffer = buffer.subarray(size);
          appendFileSync(join(runtime, 'wire.jsonl'), JSON.stringify({ id, op, body: [...body] }) + '\n');
          if (id === 1 && op === 1) {
            const registry = body.readUInt32LE(0);
            socket.write(msg(registry, 0, Buffer.concat([ints(10), string('zwlr_virtual_pointer_manager_v1'), ints(2)])));
            socket.write(msg(registry, 0, Buffer.concat([ints(11), string('wl_output'), ints(4)])));
          } else if (id === 1 && op === 0) socket.write(msg(body.readUInt32LE(0), 0, ints(42)));
          else if (id === 2 && op === 0 && body.readUInt32LE(0) === 11 && mode !== 'no-output') {
            const output = body.readUInt32LE(body.length - 4);
            const announce = () => { if (!socket.destroyed) socket.write(msg(output, 4, string('PRIVATE-1'))); };
            if (mode === 'delayed-output') setTimeout(announce, 250); else announce();
          }
        }
      });
    });
    server.listen(join(runtime, 'wayland-fixture'));
  }
} else if (command === 'swaymsg') process.exit(0);
else throw new Error(`Unexpected fixture command ${command}`);
