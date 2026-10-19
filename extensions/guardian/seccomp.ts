// Ported from openai/codex codex-rs/linux-sandbox/src/seccomp.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// Codex compiles these rules with seccompiler and installs them from its helper inside bubblewrap. Guardian emits the
// same rules as a classic BPF program, and bubblewrap installs it with `--seccomp` just before it runs the command.
// Omitted: the proxy-routed mode for Codex's managed network proxy and the legacy Landlock filesystem pipeline.

/**
 * `restricted` blocks network sockets for a sandbox without network access; `vm-socket-restricted` keeps ordinary
 * network access but denies VM sockets, which reach host services outside the filesystem sandbox.
 */
export type NetworkSeccompMode = 'restricted' | 'vm-socket-restricted';

type Syscall =
  | 'ptrace' | 'process_vm_readv' | 'process_vm_writev' | 'io_uring_setup' | 'io_uring_enter' | 'io_uring_register'
  | 'connect' | 'accept' | 'accept4' | 'bind' | 'listen' | 'getpeername' | 'getsockname' | 'shutdown' | 'sendto'
  | 'sendmmsg' | 'recvmmsg' | 'getsockopt' | 'setsockopt' | 'socket' | 'socketpair';

interface SeccompArch {
  /** `AUDIT_ARCH_*`; any other architecture, such as 32-bit compat syscalls, kills the process. */
  audit: number;
  /** x86-64 also accepts x32-ABI syscall numbers, which would otherwise slip past every rule below. */
  rejectX32: boolean;
  syscalls: Record<Syscall, number>;
}

const SECCOMP_ARCHES: Partial<Record<NodeJS.Architecture, SeccompArch>> = {
  x64: {
    audit: 0xc000_003e, rejectX32: true,
    syscalls: {
      ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
      connect: 42, accept: 43, accept4: 288, bind: 49, listen: 50, getpeername: 52, getsockname: 51, shutdown: 48, sendto: 44,
      sendmmsg: 307, recvmmsg: 299, getsockopt: 55, setsockopt: 54, socket: 41, socketpair: 53,
    },
  },
  arm64: {
    audit: 0xc000_00b7, rejectX32: false,
    syscalls: {
      ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
      connect: 203, accept: 202, accept4: 242, bind: 200, listen: 201, getpeername: 205, getsockname: 204, shutdown: 210, sendto: 206,
      sendmmsg: 269, recvmmsg: 243, getsockopt: 209, setsockopt: 208, socket: 198, socketpair: 199,
    },
  },
};

const AF_UNIX = 1;
const AF_VSOCK = 40;
const EPERM = 1;
const X32_SYSCALL_BIT = 0x4000_0000;

export const SECCOMP_RET_KILL_PROCESS = 0x8000_0000;
export const SECCOMP_RET_ERRNO = 0x0005_0000;
export const SECCOMP_RET_ALLOW = 0x7fff_0000;

// `struct seccomp_data`: the syscall number, the audit architecture, then six 64-bit arguments.
const NR_OFFSET = 0;
const ARCH_OFFSET = 4;
/** Low 32 bits of the first argument on these little-endian architectures; seccompiler's `Dword` comparison. */
const ARG0_LOW_OFFSET = 16;

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

/** The rule matches, and the syscall fails with EPERM, when the first argument compares this way. */
interface FirstArgumentCondition {
  op: 'eq' | 'ne';
  value: number;
}

/**
 * Guardian never sandboxes full-disk writes, so a filter always applies: without network access every non-Unix
 * socket is denied, and with it only the VM-socket bridge to the host is.
 */
export function networkSeccompMode(networkAccess: boolean): NetworkSeccompMode {
  return networkAccess ? 'vm-socket-restricted' : 'restricted';
}

/** Syscalls the filter denies, unconditionally (`null`) or when the first argument matches. */
export function networkSeccompRules(mode: NetworkSeccompMode): Map<Syscall, FirstArgumentCondition | null> {
  const rules = new Map<Syscall, FirstArgumentCondition | null>();
  if (mode !== 'vm-socket-restricted') {
    for (const syscall of ['ptrace', 'process_vm_readv', 'process_vm_writev'] as const) rules.set(syscall, null);
  }
  // io_uring can create AF_VSOCK sockets without a socket() syscall, so keep it unavailable in every mode with
  // socket-family restrictions.
  for (const syscall of ['io_uring_setup', 'io_uring_enter', 'io_uring_register'] as const) rules.set(syscall, null);
  if (mode === 'restricted') {
    // recvfrom stays allowed for tools such as `cargo clippy` that manage subprocesses over a socketpair.
    for (const syscall of ['connect', 'accept', 'accept4', 'bind', 'listen', 'getpeername', 'getsockname', 'shutdown', 'sendto', 'sendmmsg', 'recvmmsg', 'getsockopt', 'setsockopt'] as const) {
      rules.set(syscall, null);
    }
    rules.set('socket', { op: 'ne', value: AF_UNIX });
    rules.set('socketpair', { op: 'ne', value: AF_UNIX });
  } else {
    rules.set('socket', { op: 'eq', value: AF_VSOCK });
    rules.set('socketpair', { op: 'eq', value: AF_VSOCK });
  }
  return rules;
}

export function seccompSupported(arch: NodeJS.Architecture = process.arch): boolean {
  return SECCOMP_ARCHES[arch] !== undefined;
}

/** The filter as `struct sock_filter` instructions, in the format `bwrap --seccomp FD` reads. */
export function seccompProgram(mode: NetworkSeccompMode, arch: NodeJS.Architecture = process.arch): Buffer {
  const target = SECCOMP_ARCHES[arch];
  if (!target) throw new Error(`unsupported architecture for seccomp filter: ${arch}`);
  const instructions: [code: number, jt: number, jf: number, k: number][] = [];
  const emit = (code: number, jt: number, jf: number, k: number) => { instructions.push([code, jt, jf, k]); };
  const deny = SECCOMP_RET_ERRNO | EPERM;

  emit(BPF_LD_W_ABS, 0, 0, ARCH_OFFSET);
  emit(BPF_JMP_JEQ_K, 1, 0, target.audit);
  emit(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
  emit(BPF_LD_W_ABS, 0, 0, NR_OFFSET);
  if (target.rejectX32) {
    emit(BPF_JMP_JSET_K, 0, 1, X32_SYSCALL_BIT);
    emit(BPF_RET_K, 0, 0, deny);
  }
  const rules = [...networkSeccompRules(mode)].map(([syscall, condition]) => [target.syscalls[syscall], condition] as const).sort(([a], [b]) => a - b);
  for (const [nr, condition] of rules) {
    if (!condition) {
      emit(BPF_JMP_JEQ_K, 0, 1, nr);
      emit(BPF_RET_K, 0, 0, deny);
      continue;
    }
    // Once the syscall matches, the first argument alone decides; the accumulator no longer holds the number.
    emit(BPF_JMP_JEQ_K, 0, 4, nr);
    emit(BPF_LD_W_ABS, 0, 0, ARG0_LOW_OFFSET);
    emit(BPF_JMP_JEQ_K, 0, 1, condition.value);
    emit(BPF_RET_K, 0, 0, condition.op === 'ne' ? SECCOMP_RET_ALLOW : deny);
    emit(BPF_RET_K, 0, 0, condition.op === 'ne' ? deny : SECCOMP_RET_ALLOW);
  }
  emit(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW);

  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    program.writeUInt16LE(code, index * 8);
    program.writeUInt8(jt, index * 8 + 2);
    program.writeUInt8(jf, index * 8 + 3);
    program.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return program;
}

/** Syscall numbers, for tests and diagnostics. */
export function syscallNumber(arch: NodeJS.Architecture, syscall: Syscall): number {
  const target = SECCOMP_ARCHES[arch];
  if (!target) throw new Error(`unsupported architecture for seccomp filter: ${arch}`);
  return target.syscalls[syscall];
}

export function auditArch(arch: NodeJS.Architecture): number {
  const target = SECCOMP_ARCHES[arch];
  if (!target) throw new Error(`unsupported architecture for seccomp filter: ${arch}`);
  return target.audit;
}
