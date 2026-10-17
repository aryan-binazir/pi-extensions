// Orchestration ported from openai/codex codex-rs/core/src/tools/{orchestrator,sandboxing}.rs and
// codex-rs/sandboxing/src/denial.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalDecision, ApprovalRequest } from './approvals.ts';
import { type BashRuntime, createGuardianBashTool, isLikelySandboxDenied } from './bash.ts';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import { Policy, PolicyParser } from './rules.ts';
import { loadShell } from './shell.ts';

const darwin = { skip: process.platform !== 'darwin' && 'Seatbelt is macOS-only' };
const shell = await loadShell();

function setup(t: test.TestContext, options: { rules?: string; config?: Partial<GuardianConfig>; decisions?: ApprovalDecision[]; sandboxAvailable?: boolean } = {}) {
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
    sandboxAvailable: options.sandboxAvailable ?? true,
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
  const tool = createGuardianBashTool({ config: () => DEFAULT_GUARDIAN_CONFIG, policy: () => Policy.empty(), shell, sandboxAvailable: true,
    approvals: { request: async () => ({ type: 'approved' }) }, persistAmendment: async () => {} }, '/');
  const properties = (tool.parameters as { properties: Record<string, { enum?: string[]; anyOf?: { const: string }[] }> }).properties;
  assert.deepEqual(Object.keys(properties), ['command', 'timeout', 'sandbox_permissions', 'justification', 'prefix_rule']);
  assert.equal(tool.name, 'bash');
});

test('in-workspace commands run sandboxed without review', darwin, async t => {
  const { cwd, outside, run, requests } = setup(t);
  assert.equal(text(await run({ command: 'echo ok > inside.txt && cat inside.txt && echo $CODEX_SANDBOX' })), 'ok\nseatbelt\n');
  const denied = await run({ command: `echo no > ${outside}/file.txt` });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /Operation not permitted/);
  assert.ok(existsSync(join(cwd, 'inside.txt')) && !existsSync(join(outside, 'file.txt')));
  assert.deepEqual(requests, []);
});

test('forbidden rules reject before review or execution', async t => {
  const { cwd, run, requests } = setup(t, { rules: 'prefix_rule(pattern=["touch"], decision="forbidden", justification="use the write tool")' });
  await assert.rejects(run({ command: 'touch marker', sandbox_permissions: 'require_escalated' }), /`bash -lc 'touch marker'` rejected: use the write tool/);
  assert.ok(!existsSync(join(cwd, 'marker')));
  assert.deepEqual(requests, []);
});

test('escalation requests are reviewed with the action JSON and run unsandboxed when approved', darwin, async t => {
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

test('explicit allow rules bypass the sandbox for every segment', darwin, async t => {
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

test('approved prefix rules are persisted', darwin, async t => {
  const { run, persisted } = setup(t, { decisions: [{ type: 'approved', persist: ['cargo', 'install'] }] });
  await run({ command: 'true', sandbox_permissions: 'require_escalated', prefix_rule: ['cargo', 'install'] });
  assert.deepEqual(persisted, [['cargo', 'install']]);
});

test('unless-trusted retries a sandbox denial outside the sandbox after approval', darwin, async t => {
  const { outside, run, requests } = setup(t, { config: { approvalPolicy: 'unless-trusted' }, decisions: [{ type: 'approved' }, { type: 'approved' }] });
  const target = join(outside, 'retried.txt');
  await run({ command: `echo retried > ${target}` });
  assert.equal(readFileSync(target, 'utf8'), 'retried\n');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].reason, 'command failed; retry without sandbox?');
  assert.equal(requests[1].action.sandbox_permissions, 'require_escalated');
});

test('on-request returns sandbox denials to the agent without retrying', darwin, async t => {
  const { outside, run, requests } = setup(t);
  const result = await run({ command: `echo x > ${outside}/no.txt` });
  assert.equal(result.isError, true);
  assert.deepEqual(requests, []);
});

test('without a platform sandbox every command needs approval', async t => {
  const { run, requests } = setup(t, { sandboxAvailable: false, decisions: [{ type: 'approved' }] });
  assert.equal(text(await run({ command: 'echo unsandboxed' })), 'unsandboxed\n');
  assert.equal(requests[0].action.sandbox_permissions, 'require_escalated');
});

test('disabled Guardian runs commands as plain Pi bash', async t => {
  const { outside, run, requests } = setup(t, { config: { enabled: false } });
  await run({ command: `touch ${outside}/plain` });
  assert.ok(existsSync(join(outside, 'plain')));
  assert.deepEqual(requests, []);
});

test('null optional arguments from strict tool schemas mean unset', darwin, async t => {
  const { run, requests } = setup(t);
  assert.equal(text(await run({ command: 'echo ok', timeout: null, sandbox_permissions: null, justification: null, prefix_rule: null })), 'ok\n');
  assert.deepEqual(requests, []);
});

test('commands that cannot be quoted for the sandbox fail instead of running', darwin, async t => {
  const { run } = setup(t);
  await assert.rejects(run({ command: 'echo a\u0000b' }), /cannot be run in the sandbox: it contains a NUL byte/);
});

test('sandbox denial heuristic matches Codex keywords', () => {
  assert.ok(isLikelySandboxDenied(1, 'bash: /x: Operation not permitted'));
  assert.ok(isLikelySandboxDenied(2, 'touch: /x: Read-only file system'));
  assert.ok(!isLikelySandboxDenied(0, 'Operation not permitted'));
  assert.ok(!isLikelySandboxDenied(1, 'tests failed'));
});
