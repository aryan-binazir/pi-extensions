// Orchestration ported from openai/codex codex-rs/core/src/tools/{orchestrator,sandboxing}.rs and
// codex-rs/sandboxing/src/denial.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalDecision, ApprovalRequest } from './approvals.ts';
import { type BashRuntime, createGuardianBashTool } from './bash.ts';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import { Policy, PolicyParser } from './rules.ts';
import { detectPlatformSandbox, isLikelySandboxDenied, type PlatformSandbox } from './sandbox.ts';
import { loadShell } from './shell.ts';

const detected = (await detectPlatformSandbox()).sandbox;
const sandboxed = { skip: !detected && 'this platform has no usable sandbox' };
/** The sandbox's message for a write outside the writable roots: Seatbelt's EPERM or the read-only bind's EROFS. */
const WRITE_DENIED = /Operation not permitted|Read-only file system/;
const shell = await loadShell();

function setup(t: test.TestContext, options: { rules?: string; config?: Partial<GuardianConfig>; decisions?: ApprovalDecision[]; sandbox?: PlatformSandbox | null; shellSettings?: { shellPath?: string; commandPrefix?: string } } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-bash-cwd-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-bash-outside-')));
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  let policy = Policy.empty();
  if (options.rules) {
    const parser = new PolicyParser();
    parser.parse('test.rules', options.rules);
    policy = parser.build();
  }
  const requests: ApprovalRequest[] = [], persisted: string[][] = [];
  const decisions = [...(options.decisions ?? [])];
  const config: GuardianConfig = {
    ...DEFAULT_GUARDIAN_CONFIG, ...options.config,
    // Keep the scratch directory outside the sandbox's writable roots.
    sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, excludeSlashTmp: true, excludeTmpdirEnvVar: true, ...options.config?.sandbox },
  };
  const runtime: BashRuntime = {
    config: () => config,
    policy: () => policy,
    shell,
    sandbox: options.sandbox === null ? undefined : options.sandbox ?? detected,
    shellSettings: () => options.shellSettings ?? {},
    approvals: { request: async request => { requests.push(request); return decisions.shift() ?? { type: 'rejected', message: 'no scripted decision' }; } },
    persistAmendment: async prefix => { persisted.push(prefix); },
  };
  const tool = createGuardianBashTool(runtime, cwd);
  const ctx = { cwd, hasUI: true, abort: () => {}, ui: { notify: () => {}, select: async () => undefined },
    sessionManager: { getSessionId: () => 's', getSessionFile: () => undefined } };
  const run = (params: Record<string, unknown>) => tool.execute('call-1', params as never, undefined, undefined, ctx as never);
  return { cwd, outside, run, requests, persisted };
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(part => part.text ?? '').join('');

test('the tool exposes Codex approval parameters', () => {
  const tool = createGuardianBashTool({ config: () => DEFAULT_GUARDIAN_CONFIG, policy: () => Policy.empty(), shellSettings: () => ({}), shell, sandbox: detected,
    approvals: { request: async () => ({ type: 'approved' }) }, persistAmendment: async () => {} }, '/');
  const properties = (tool.parameters as { properties: Record<string, { enum?: string[]; anyOf?: { const: string }[] }> }).properties;
  assert.deepEqual(Object.keys(properties), ['command', 'timeout', 'sandbox_permissions', 'justification', 'prefix_rule']);
  assert.equal(tool.name, 'bash');
});

test('in-workspace commands run sandboxed without review', sandboxed, async t => {
  const { cwd, outside, run, requests } = setup(t);
  assert.equal(text(await run({ command: 'echo ok > inside.txt && cat inside.txt && echo ${CODEX_SANDBOX:-unset} $CODEX_SANDBOX_NETWORK_DISABLED' })),
    `ok\n${detected?.kind === 'seatbelt' ? 'seatbelt' : 'unset'} 1\n`);
  const denied = await run({ command: `echo no > ${outside}/file.txt` });
  assert.equal(denied.isError, true);
  assert.match(text(denied), WRITE_DENIED);
  assert.ok(existsSync(join(cwd, 'inside.txt')) && !existsSync(join(outside, 'file.txt')));
  assert.deepEqual(requests, []);
});

test('forbidden rules reject before review or execution', async t => {
  const { cwd, run, requests } = setup(t, { rules: 'prefix_rule(pattern=["touch"], decision="forbidden", justification="use the write tool")' });
  await assert.rejects(run({ command: 'touch marker', sandbox_permissions: 'require_escalated' }), /`bash -lc 'touch marker'` rejected: use the write tool/);
  assert.ok(!existsSync(join(cwd, 'marker')));
  assert.deepEqual(requests, []);
});

test('escalation requests are reviewed with the action JSON and run unsandboxed when approved', sandboxed, async t => {
  const { outside, run, requests } = setup(t, { decisions: [{ type: 'approved' }] });
  const target = join(outside, 'escalated.txt');
  await run({ command: `echo yes > ${target}`, sandbox_permissions: 'require_escalated', justification: 'Write the shared cache?', prefix_rule: ['tee'] });
  assert.equal(readFileSync(target, 'utf8'), 'yes\n');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].action, {
    tool: 'bash', command: ['bash', '-lc', `echo yes > ${target}`], cwd: requests[0].action.cwd, sandbox_permissions: 'require_escalated',
    justification: 'Write the shared cache?', environment_id: 'local',
  });
  assert.equal(requests[0].justification, 'Write the shared cache?');
});

test('rejected escalations return the rejection to the agent without running', async t => {
  const { outside, run } = setup(t, { decisions: [{ type: 'rejected', message: 'This action was rejected due to unacceptable risk.' }] });
  await assert.rejects(run({ command: `touch ${outside}/x`, sandbox_permissions: 'require_escalated' }), /unacceptable risk/);
  assert.ok(!existsSync(join(outside, 'x')));
});

test('explicit allow rules bypass the sandbox for every segment', sandboxed, async t => {
  const { outside, run, requests } = setup(t, { rules: 'prefix_rule(pattern=["touch"], decision="allow")' });
  await run({ command: `touch ${outside}/allowed` });
  assert.ok(existsSync(join(outside, 'allowed')));
  assert.deepEqual(requests, []);
});

test('forced rm needs approval even inside the sandbox', async t => {
  const { run, requests } = setup(t, { decisions: [{ type: 'rejected', message: 'no' }] });
  await assert.rejects(run({ command: 'rm -rf build' }), /no/);
  assert.equal(requests[0].action.sandbox_permissions, 'use_default');
  assert.deepEqual(requests[0].amendment, ['rm', '-rf', 'build']);
});

test('approved prefix rules are persisted', sandboxed, async t => {
  const { run, persisted } = setup(t, { decisions: [{ type: 'approved', persist: ['cargo', 'install'] }] });
  await run({ command: 'true', sandbox_permissions: 'require_escalated', prefix_rule: ['cargo', 'install'] });
  assert.deepEqual(persisted, [['cargo', 'install']]);
});

test('unless-trusted retries a sandbox denial outside the sandbox after approval', sandboxed, async t => {
  const { outside, run, requests } = setup(t, { config: { approvalPolicy: 'unless-trusted' }, decisions: [{ type: 'approved' }, { type: 'approved' }] });
  const target = join(outside, 'retried.txt');
  await run({ command: `echo retried > ${target}` });
  assert.equal(readFileSync(target, 'utf8'), 'retried\n');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].reason, 'command failed; retry without sandbox?');
  assert.equal(requests[1].action.sandbox_permissions, 'require_escalated');
});

test('on-request returns sandbox denials to the agent without retrying', sandboxed, async t => {
  const { outside, run, requests } = setup(t);
  const result = await run({ command: `echo x > ${outside}/no.txt` });
  assert.equal(result.isError, true);
  assert.deepEqual(requests, []);
});

test('without a platform sandbox every command needs approval', async t => {
  const { run, requests } = setup(t, { sandbox: null, decisions: [{ type: 'approved' }] });
  assert.equal(text(await run({ command: 'echo unsandboxed' })), 'unsandboxed\n');
  assert.equal(requests[0].action.sandbox_permissions, 'require_escalated');
});

test('disabled Guardian runs commands as plain Pi bash', async t => {
  const { outside, run, requests } = setup(t, { config: { enabled: false } });
  await run({ command: `touch ${outside}/plain` });
  assert.ok(existsSync(join(outside, 'plain')));
  assert.deepEqual(requests, []);
});

test('null optional arguments from strict tool schemas mean unset', sandboxed, async t => {
  const { run, requests } = setup(t);
  assert.equal(text(await run({ command: 'echo ok', timeout: null, sandbox_permissions: null, justification: null, prefix_rule: null })), 'ok\n');
  assert.deepEqual(requests, []);
});

test('commands that cannot be quoted for the sandbox fail instead of running', sandboxed, async t => {
  const { run } = setup(t);
  await assert.rejects(run({ command: 'echo a\u0000b' }), /cannot be run in the sandbox: it contains a NUL byte/);
});

test('the sandbox starts directly, so no unsandboxed shell sources BASH_ENV first', sandboxed, async t => {
  const { cwd, outside, run } = setup(t);
  const marker = join(outside, 'pwned');
  writeFileSync(join(cwd, 'startup.sh'), `echo pwned > ${marker} 2>/dev/null\n`);
  const previous = { BASH_ENV: process.env.BASH_ENV, SHLVL: process.env.SHLVL };
  process.env.BASH_ENV = join(cwd, 'startup.sh');
  // As when Pi starts from a terminal. A top-level bash without SHLVL asks getpeername whether rshd started it; Codex's
  // network filter answers EPERM, which bash reads as yes, so it would source ~/.bashrc instead of BASH_ENV.
  process.env.SHLVL = '1';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const output = text(await run({ command: 'echo harmless' }));
  assert.ok(output.includes('harmless'), output);
  assert.ok(!existsSync(marker), 'the startup file ran only inside the sandbox, where its write was denied');
  assert.match(output, /startup\.sh[\s\S]*(Operation not permitted|Read-only file system)/);
});

test('sandboxed commands honor timeouts and Pi shell settings', sandboxed, async t => {
  const { run } = setup(t, { shellSettings: { commandPrefix: 'export GREETING=prefixed' } });
  assert.equal(text(await run({ command: 'echo $GREETING' })), 'prefixed\n');
  await assert.rejects(run({ command: 'sleep 5', timeout: 1 }), /timed out after 1 seconds/);
  const disabled = setup(t, { config: { enabled: false }, shellSettings: { commandPrefix: 'export GREETING=plain' } });
  assert.equal(text(await disabled.run({ command: 'echo $GREETING' })), 'plain\n');
});

test('bundled Railway rules apply everywhere a literal command can hide, even with Guardian off', async t => {
  for (const config of [{}, { enabled: false }, { sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'danger-full-access' as const } }]) {
    const { run, requests } = setup(t, { config, rules: 'prefix_rule(pattern=["/opt/homebrew/bin/railway"], decision="allow")\nprefix_rule(pattern=["railway"], decision="allow")' });
    for (const command of ['railway delete', '/opt/homebrew/bin/railway volume delete pg', 'if true; then railway down; fi', 'echo "$(railway env rm prod)"',
      "bash -c 'railway delete'", 'sudo railway volume rm pg', 'env RAILWAY_TOKEN=x railway delete', 'cd app > /dev/null && railway delete 2>&1']) {
      await assert.rejects(run({ command }), /destructive Railway operations are permanently blocked/, `${JSON.stringify(config)} ${command}`);
    }
    assert.deepEqual(requests, []);
  }
});

test('Railway commands that reach databases need review', async t => {
  const { run, requests } = setup(t, { decisions: [{ type: 'rejected', message: 'denied' }] });
  await assert.rejects(run({ command: 'railway connect postgres' }), /denied/);
  assert.match(requests[0].reason ?? '', /Railway commands that can reach databases or storage are reviewed/);
});

test('a backgrounded command does not hold the sandboxed call open', sandboxed, async t => {
  const { run } = setup(t);
  const started = Date.now();
  assert.equal(text(await run({ command: 'sleep 5 & echo started' })).trim(), 'started');
  assert.ok(Date.now() - started < 2_000, `returned in ${Date.now() - started}ms`);
});

test('the configured command prefix is judged as part of the script that runs', async t => {
  const { cwd, run, requests } = setup(t, {
    rules: 'prefix_rule(pattern=["touch"], decision="forbidden", justification="no markers")',
    shellSettings: { commandPrefix: 'touch prefix-marker' },
  });
  await assert.rejects(run({ command: 'echo hi' }), /no markers/);
  assert.ok(!existsSync(join(cwd, 'prefix-marker')));
  assert.deepEqual(requests, []);
  const reviewed = setup(t, { shellSettings: { commandPrefix: 'export A=1' }, decisions: [{ type: 'rejected', message: 'no' }] });
  await assert.rejects(reviewed.run({ command: 'echo hi', sandbox_permissions: 'require_escalated' }), /no/);
  assert.deepEqual(reviewed.requests[0].action.command, ['bash', '-lc', 'export A=1\necho hi']);
});

test('invalid timeouts are rejected before anything runs', async t => {
  const { run } = setup(t);
  for (const timeout of [-1, 0, Number.POSITIVE_INFINITY, 3_000_000]) {
    await assert.rejects(run({ command: 'echo hi', timeout }), /Invalid timeout/, String(timeout));
  }
});

test('sandbox denial heuristic matches Codex keywords, and SIGSYS on Linux', () => {
  for (const kind of ['seatbelt', 'bubblewrap'] as const) {
    assert.ok(isLikelySandboxDenied(1, 'bash: /x: Operation not permitted', kind));
    assert.ok(isLikelySandboxDenied(2, 'touch: /x: Read-only file system', kind));
    assert.ok(!isLikelySandboxDenied(0, 'Operation not permitted', kind));
    assert.ok(!isLikelySandboxDenied(1, 'tests failed', kind));
  }
  assert.ok(isLikelySandboxDenied(159, '', 'bubblewrap'));
  assert.ok(!isLikelySandboxDenied(159, '', 'seatbelt'));
  assert.ok(!isLikelySandboxDenied(127, 'command not found', 'bubblewrap'));
});
