// Ported from the tests in openai/codex codex-rs/linux-sandbox/src/seccomp.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. Codex trusts seccompiler for the filter itself; Guardian builds the BPF by hand, so these
// tests also run the program through a small classic-BPF interpreter for both architectures.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditArch, networkSeccompMode, networkSeccompRules, SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO, SECCOMP_RET_KILL_PROCESS,
  seccompProgram, seccompSupported, syscallNumber,
} from './seccomp.ts';

const DENIED = SECCOMP_RET_ERRNO | 1;
const AF_UNIX = 1, AF_INET = 2, AF_INET6 = 10, AF_VSOCK = 40;
const ARCHES = ['x64', 'arm64'] as const;

/** Runs a classic BPF seccomp program over one `struct seccomp_data`. */
function evaluate(program: Buffer, data: { nr: number; arch: number; args?: bigint[] }): number {
  const seccompData = Buffer.alloc(64);
  seccompData.writeUInt32LE(data.nr >>> 0, 0);
  seccompData.writeUInt32LE(data.arch >>> 0, 4);
  (data.args ?? []).forEach((arg, index) => seccompData.writeBigUInt64LE(arg, 16 + index * 8));
  let accumulator = 0;
  for (let pc = 0; pc < program.length / 8;) {
    const code = program.readUInt16LE(pc * 8), jt = program.readUInt8(pc * 8 + 2), jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    switch (code) {
      case 0x20: accumulator = seccompData.readUInt32LE(k); pc++; break;
      case 0x15: pc += 1 + (accumulator === k ? jt : jf); break;
      case 0x45: pc += 1 + ((accumulator & k) !== 0 ? jt : jf); break;
      case 0x06: return k;
      default: throw new Error(`unexpected BPF opcode ${code.toString(16)}`);
    }
  }
  throw new Error('BPF program fell off the end');
}

function syscall(arch: (typeof ARCHES)[number], mode: Parameters<typeof seccompProgram>[0], name: Parameters<typeof syscallNumber>[1] | number, ...args: number[]) {
  const nr = typeof name === 'number' ? name : syscallNumber(arch, name);
  return evaluate(seccompProgram(mode, arch), { nr, arch: auditArch(arch), args: args.map(BigInt) });
}

test('network access selects the VM-socket filter and isolation selects the restricted filter', () => {
  assert.equal(networkSeccompMode(true), 'vm-socket-restricted');
  assert.equal(networkSeccompMode(false), 'restricted');
});

test('restricted mode denies network syscalls but keeps Unix sockets and recvfrom', () => {
  for (const arch of ARCHES) {
    for (const name of ['connect', 'accept', 'accept4', 'bind', 'listen', 'getpeername', 'getsockname', 'shutdown', 'sendto', 'sendmmsg', 'recvmmsg', 'getsockopt', 'setsockopt'] as const) {
      assert.equal(syscall(arch, 'restricted', name), DENIED, `${arch} ${name}`);
    }
    for (const family of [AF_INET, AF_INET6, AF_VSOCK]) {
      assert.equal(syscall(arch, 'restricted', 'socket', family), DENIED, `${arch} socket(${family})`);
      assert.equal(syscall(arch, 'restricted', 'socketpair', family), DENIED, `${arch} socketpair(${family})`);
    }
    assert.equal(syscall(arch, 'restricted', 'socket', AF_UNIX), SECCOMP_RET_ALLOW);
    assert.equal(syscall(arch, 'restricted', 'socketpair', AF_UNIX), SECCOMP_RET_ALLOW);
    // seccompiler's Dword comparison reads only the low 32 bits of the argument.
    assert.equal(evaluate(seccompProgram('restricted', arch), { nr: syscallNumber(arch, 'socket'), arch: auditArch(arch), args: [(1n << 32n) | BigInt(AF_UNIX)] }), SECCOMP_RET_ALLOW);
    const recvfrom = arch === 'x64' ? 45 : 207;
    assert.equal(syscall(arch, 'restricted', recvfrom), SECCOMP_RET_ALLOW, `${arch} recvfrom`);
  }
});

test('restricted mode denies ptrace, cross-process memory access and io_uring', () => {
  for (const arch of ARCHES) {
    for (const name of ['ptrace', 'process_vm_readv', 'process_vm_writev', 'io_uring_setup', 'io_uring_enter', 'io_uring_register'] as const) {
      assert.equal(syscall(arch, 'restricted', name), DENIED, `${arch} ${name}`);
    }
  }
});

test('VM-socket mode keeps ordinary networking and ptrace but denies VM sockets and io_uring', () => {
  for (const arch of ARCHES) {
    for (const name of ['connect', 'bind', 'listen', 'sendto', 'ptrace', 'process_vm_readv'] as const) {
      assert.equal(syscall(arch, 'vm-socket-restricted', name), SECCOMP_RET_ALLOW, `${arch} ${name}`);
    }
    for (const family of [AF_UNIX, AF_INET, AF_INET6]) assert.equal(syscall(arch, 'vm-socket-restricted', 'socket', family), SECCOMP_RET_ALLOW);
    assert.equal(syscall(arch, 'vm-socket-restricted', 'socket', AF_VSOCK), DENIED);
    assert.equal(syscall(arch, 'vm-socket-restricted', 'socketpair', AF_VSOCK), DENIED);
    for (const name of ['io_uring_setup', 'io_uring_enter', 'io_uring_register'] as const) {
      assert.equal(syscall(arch, 'vm-socket-restricted', name), DENIED, `${arch} ${name}`);
    }
  }
});

test('ordinary syscalls are allowed', () => {
  for (const arch of ARCHES) {
    const [read, write, openat] = arch === 'x64' ? [0, 1, 257] : [63, 64, 56];
    for (const nr of [read, write, openat]) {
      assert.equal(syscall(arch, 'restricted', nr), SECCOMP_RET_ALLOW);
      assert.equal(syscall(arch, 'vm-socket-restricted', nr), SECCOMP_RET_ALLOW);
    }
  }
});

test('a foreign architecture kills the process, as seccompiler does', () => {
  const AUDIT_ARCH_I386 = 0x4000_0003;
  assert.equal(evaluate(seccompProgram('restricted', 'x64'), { nr: 0, arch: AUDIT_ARCH_I386 }), SECCOMP_RET_KILL_PROCESS);
  assert.equal(evaluate(seccompProgram('restricted', 'arm64'), { nr: 63, arch: auditArch('x64') }), SECCOMP_RET_KILL_PROCESS);
});

test('x32 syscall numbers cannot route around the x86-64 rules', () => {
  const x32Socket = 0x4000_0000 + syscallNumber('x64', 'socket');
  for (const mode of ['restricted', 'vm-socket-restricted'] as const) {
    assert.equal(syscall('x64', mode, x32Socket, AF_VSOCK), DENIED);
    assert.equal(syscall('x64', mode, 0x4000_0000), DENIED);
  }
});

test('the rule set matches Codex for each mode', () => {
  assert.deepEqual([...networkSeccompRules('vm-socket-restricted').keys()].sort(),
    ['io_uring_enter', 'io_uring_register', 'io_uring_setup', 'socket', 'socketpair']);
  assert.equal(networkSeccompRules('restricted').size, 21);
});

test('only x86-64 and arm64 have a filter', () => {
  assert.equal(seccompSupported('x64'), true);
  assert.equal(seccompSupported('arm64'), true);
  assert.equal(seccompSupported('riscv64'), false);
  assert.throws(() => seccompProgram('restricted', 'riscv64'), /unsupported architecture/);
});
