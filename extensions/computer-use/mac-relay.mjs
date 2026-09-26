import { spawn } from 'node:child_process';
const parent = process.ppid;
const child = spawn(process.argv[2], ['mcp'], { stdio: 'inherit' });
let stopping = false;
let killTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
}
const watch = setInterval(() => {
  if (process.ppid !== parent) return stop();
  try { process.kill(parent, 0); } catch { stop(); }
}, 250);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
child.on('error', () => { clearInterval(watch); clearTimeout(killTimer); process.exitCode = 1; });
child.on('exit', code => { clearInterval(watch); clearTimeout(killTimer); process.exitCode = code ?? 1; });
