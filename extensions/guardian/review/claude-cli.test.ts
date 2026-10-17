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

test('Claude reviews through claude -p with read-only tools and no user customizations', () => {
  assert.deepEqual(claudeCliArgs({ systemPrompt: 'SYSTEM', model: 'claude-opus-5-5', reasoning: 'minimal' }), [
    '-p', '--safe-mode', '--model', 'claude-opus-5-5', '--effort', 'low', '--system-prompt', 'SYSTEM',
    '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json',
  ]);
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
