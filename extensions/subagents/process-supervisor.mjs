// This adapter, not the model, owns child liveness. fd 3 is the owner pipe;
// fd 4 reports the real child exit before the adapter kills its entire group.
import { spawn } from 'node:child_process';
import { fstatSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';

let owner;
try {
  for (const fd of [3, 4]) {
    const descriptor = fstatSync(fd);
    if (!descriptor.isFIFO() && !descriptor.isSocket()) throw new Error('Invalid supervision pipe');
  }
  process.kill(-process.pid, 0); // Registry must launch us as a process-group leader.
  // A Socket uses cancellable event-loop reads; fs streams may block shutdown.
  owner = new Socket({fd: 3, readable: true, writable: false});
} catch {
  console.error('Subagent supervision requires inherited pipes and a dedicated process group');
  process.exit(1);
}

let child, escalation, childCode;
let stopping = false, exited = false, finished = false;
const signalGroup = signal => {
  try { process.kill(-process.pid, signal); } catch { child?.kill(signal); }
};
const finish = code => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(escalation);
  owner.destroy();
  // Only the adapter inherits this control descriptor, not Pi. A successful
  // report does not replace Pi's required final assistant stop event.
  const kill = () => {
    try { writeSync(4, `${stopping ? 143 : code}\n`); } catch { /* Owner already gone. */ }
    signalGroup('SIGKILL'); // Includes stubborn descendants even without an owner.
    process.exit(stopping ? 143 : code);
  };
  const flushDeadline = setTimeout(kill, 2000);
  let pending = 2;
  const flushed = () => { if (--pending === 0) { clearTimeout(flushDeadline); kill(); } };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
};
const stop = () => {
  if (stopping || exited || finished) return;
  stopping = true;
  signalGroup('SIGTERM');
  escalation = setTimeout(() => finish(143), 2000);
};
owner.on('end', stop);
owner.on('error', stop);
owner.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);

const timeout = Number(process.env.PI_SUBAGENT_TIMEOUT_MS);
if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600000) {
  console.error('Invalid supervised child timeout');
  owner.destroy();
  process.exit(1);
}
const deadline = setTimeout(stop, timeout);
child = spawn(process.argv[2], process.argv.slice(3), {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout, {end: false});
child.stderr.pipe(process.stderr, {end: false});
child.on('error', error => { console.error(`Subagent launch failed: ${error.message}`); });
child.on('exit', code => {
  exited = true;
  childCode = code ?? 1;
  signalGroup('SIGTERM');
  // Descendants may retain Pi's stdout/stderr after Pi itself has exited.
  escalation ??= setTimeout(() => finish(childCode), 2000);
});
child.on('close', code => finish(code ?? childCode ?? 1));
