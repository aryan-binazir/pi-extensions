import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeCliArgs, runClaudeCliReview } from './claude-cli.ts';

/** A stand-in `claude` that records its argv and stdin, then prints the scripted result. */
function fakeClaude(t: test.TestContext, script: string): { command: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, 'claude'), record = join(dir, 'record.json');
  writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }));
  ${script}
});
`);
  chmodSync(command, 0o755);
  return { command, record };
}

const input = (command: string, overrides = {}) => ({
  command, systemPrompt: 'SYSTEM', userContent: ['# AGENTS.md instructions for /repo', '<environment_context />', 'REQUEST\n', 'MORE\n'], cwd: tmpdir(),
  model: 'claude-opus-5-5', reasoning: 'high' as const, deadline: Date.now() + 10_000, ...overrides,
});

test('Claude reviews with read-only tools and no settings from the reviewed workspace', () => {
  assert.deepEqual(claudeCliArgs({ systemPrompt: 'SYSTEM', model: 'claude-opus-5-5', reasoning: 'minimal', cwd: '/repo' }), [
    '-p', '--safe-mode', '--restricted', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
    '--add-dir', '/repo', '--model', 'claude-opus-5-5', '--effort', 'low', '--system-prompt', 'SYSTEM',
    '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'dontAsk',
    '--output-format', 'json',
  ]);
});

test('Claude never runs in the reviewed workspace, so its settings and hooks cannot be planted there', async t => {
  const { command, record } = fakeClaude(t, `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{"outcome":"allow"}' }));`);
  const workspace = mkdtempSync(join(tmpdir(), 'guardian-claude-workspace-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  await runClaudeCliReview(input(command, { cwd: workspace }));
  const recorded = JSON.parse(readFileSync(record, 'utf8'));
  assert.notEqual(recorded.cwd, workspace, 'the reviewer runs outside the directory the agent can write');
  assert.ok(recorded.argv.includes('--restricted') && recorded.argv.includes('--setting-sources'));
  assert.equal(recorded.argv[recorded.argv.indexOf('--add-dir') + 1], workspace, 'the workspace stays readable');
});

test('the assessment comes from the JSON result and the request goes on stdin', async t => {
  const { command, record } = fakeClaude(t, `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Checked.\\n{"outcome":"deny","risk_level":"high","rationale":"Pushes to main."}' }));`);
  assert.deepEqual(await runClaudeCliReview(input(command)), {
    type: 'completed', assessment: { riskLevel: 'high', userAuthorization: 'unknown', outcome: 'deny', rationale: 'Pushes to main.' },
  });
  const recorded = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(recorded.stdin, '# AGENTS.md instructions for /repo\n\n<environment_context />\n\nREQUEST\nMORE\n');
  assert.equal(recorded.argv[recorded.argv.indexOf('--effort') + 1], 'high');
});

test('a completed CLI review releases descendants in its process group', async t => {
  const { command } = fakeClaude(t, `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(__filename + '.pid', String(child.pid));
    child.unref();
    process.stdout.write(JSON.stringify({ is_error: false, result: '{"outcome":"allow"}' }));
  `);
  let descendant = 0;
  t.after(() => { if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } });
  const outcome = await runClaudeCliReview(input(command));
  descendant = Number(readFileSync(command + '.pid', 'utf8'));
  assert.equal(outcome.type, 'completed');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(descendant, 0), /ESRCH/, 'completion must release the owned descendant');
  descendant = 0;
});

test('API errors are session errors classified for retry; bad output is a parse error', async t => {
  const overloaded = fakeClaude(t, `process.stdout.write(JSON.stringify({ type: 'result', is_error: true, api_error_status: 529, result: 'Overloaded' })); process.exit(1);`);
  assert.deepEqual(await runClaudeCliReview(input(overloaded.command)), { type: 'error', error: { type: 'session', message: 'claude -p failed (529): Overloaded', transient: true } });
  const unauthorized = fakeClaude(t, `process.stderr.write('Invalid API key'); process.exit(1);`);
  assert.deepEqual(await runClaudeCliReview(input(unauthorized.command)), { type: 'error', error: { type: 'session', message: 'claude -p failed (exit 1): Invalid API key', transient: false } });
  const prose = fakeClaude(t, `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Looks fine.' }));`);
  assert.deepEqual(await runClaudeCliReview(input(prose.command)), { type: 'error', error: { type: 'parse', message: 'guardian assessment was not valid JSON' } });
});

test('the review deadline and cancellation stop claude', async t => {
  const hang = fakeClaude(t, 'setInterval(() => {}, 1000);');
  assert.deepEqual(await runClaudeCliReview(input(hang.command, { deadline: Date.now() + 200 })), { type: 'error', error: { type: 'timeout' } });
  const controller = new AbortController();
  const pending = runClaudeCliReview(input(hang.command, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 100);
  assert.deepEqual(await pending, { type: 'error', error: { type: 'cancelled' } });
});

test('a missing claude executable is a clear session error', async () => {
  const outcome = await runClaudeCliReview(input('/nonexistent/claude'));
  assert.equal(outcome.type === 'error' && outcome.error.type, 'session');
  assert.match(outcome.type === 'error' && 'message' in outcome.error ? outcome.error.message : '', /claude -p could not start/);
});

test('CLI startup diagnostics remain bounded when stderr exceeds the capture cap', async t => {
  const fixture = fakeClaude(t, "process.stderr.end('E'.repeat(2_000_000), () => process.exit(127));");
  const outcome = await runClaudeCliReview(input(fixture.command));
  assert.equal(outcome.type, 'error');
  if (outcome.type !== 'error' || outcome.error.type !== 'session') throw new Error('expected a session error');
  assert.match(outcome.error.message, /claude -p could not start: E/);
  assert.ok(outcome.error.message.length < 600);
  assert.equal(outcome.error.transient, false);
});
