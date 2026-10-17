// Covers the Pi reviewer turn that stands in for Codex's Guardian review session (codex-rs/core/src/guardian/review_session.rs,
// codex-rs/ext/guardian-reviewer/src/execution.rs @ ce0323f, Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { buildReviewerPrompt, EXEC_COMMAND_TOOL, type ReviewerTurn, runReadOnlyCommand, runReviewerTurn } from './reviewer.ts';

const reply = (content: AssistantMessage['content'], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant', content, api: 'openai-responses', provider: 'test', model: 'luna', usage: {} as AssistantMessage['usage'],
  stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 0, ...extra,
});

function scripted(...replies: (AssistantMessage | ((context: Context, signal: AbortSignal) => Promise<AssistantMessage>))[]) {
  const contexts: Context[] = [];
  const complete: ReviewerTurn['complete'] = async (context, signal) => {
    contexts.push(structuredClone(context));
    const next = replies.shift();
    if (!next) throw new Error('unexpected model call');
    return typeof next === 'function' ? next(context, signal) : next;
  };
  return { contexts, complete };
}

const baseTurn = (complete: ReviewerTurn['complete'], overrides: Partial<ReviewerTurn> = {}): ReviewerTurn => ({
  systemPrompt: 'SYSTEM', userContent: ['first\n', 'second\n'], cwd: '/repo', deadline: Date.now() + 5_000, complete,
  runCommand: async () => { throw new Error('unexpected command'); }, ...overrides,
});

test('a direct allow completes with the user content delivered as one message', async () => {
  const { contexts, complete } = scripted(reply([{ type: 'text', text: '{"outcome":"allow"}' }]));
  assert.deepEqual(await runReviewerTurn(baseTurn(complete)), {
    type: 'completed', assessment: { riskLevel: 'low', userAuthorization: 'unknown', outcome: 'allow', rationale: 'Auto-review returned a low-risk allow decision.' },
  });
  assert.equal(contexts[0].systemPrompt, 'SYSTEM');
  assert.deepEqual(contexts[0].tools?.map(tool => tool.name), ['exec_command']);
  assert.deepEqual(contexts[0].messages.map(message => message.role === 'user' && message.content), [[{ type: 'text', text: 'first\n' }, { type: 'text', text: 'second\n' }]]);
});

test('read-only tool calls run and feed results back before the final assessment', async () => {
  const commands: [string, string][] = [];
  const { contexts, complete } = scripted(
    reply([{ type: 'toolCall', id: 't1', name: 'exec_command', arguments: { cmd: 'git remote -v', workdir: 'sub' } }]),
    reply([{ type: 'text', text: 'Checked.\n{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Pushes to an unverified remote."}' }]),
  );
  const outcome = await runReviewerTurn(baseTurn(complete, {
    runCommand: async (command, workdir) => { commands.push([command, workdir]); return 'origin git@example.com:x.git (push)\nexit code: 0'; },
  }));
  assert.deepEqual(commands, [['git remote -v', '/repo/sub']]);
  assert.equal(outcome.type === 'completed' && outcome.assessment.outcome, 'deny');
  const toolResult = contexts[1].messages.at(-1);
  assert.equal(toolResult?.role, 'toolResult');
  assert.deepEqual(toolResult?.role === 'toolResult' && toolResult.content, [{ type: 'text', text: 'origin git@example.com:x.git (push)\nexit code: 0' }]);
});

test('unknown tools and invalid arguments are reported back to the reviewer', async () => {
  const { contexts, complete } = scripted(
    reply([{ type: 'toolCall', id: 't1', name: 'write_file', arguments: {} }, { type: 'toolCall', id: 't2', name: 'exec_command', arguments: { cmd: 7 } }]),
    reply([{ type: 'text', text: '{"outcome":"allow"}' }]),
  );
  await runReviewerTurn(baseTurn(complete));
  const results = contexts[1].messages.filter(message => message.role === 'toolResult');
  assert.deepEqual(results.map(message => message.role === 'toolResult' && [message.isError, message.content]), [
    [true, [{ type: 'text', text: 'Unknown tool `write_file`. Only `exec_command` is available.' }]],
    [true, [{ type: 'text', text: '`exec_command` requires a string `cmd`.' }]],
  ]);
});

test('provider errors become session errors classified for retry', async () => {
  for (const [errorMessage, transient] of [['503 Service Unavailable', true], ['400 invalid request', false]] as const) {
    const { complete } = scripted(reply([], { stopReason: 'error', errorMessage }));
    assert.deepEqual(await runReviewerTurn(baseTurn(complete)), { type: 'error', error: { type: 'session', message: errorMessage, transient } });
  }
});

test('non-JSON final answers are parse errors', async () => {
  const { complete } = scripted(reply([{ type: 'text', text: 'Looks fine.' }]));
  assert.deepEqual(await runReviewerTurn(baseTurn(complete)), { type: 'error', error: { type: 'parse', message: 'guardian assessment was not valid JSON' } });
});

test('missing final text completes without an assessment payload', async () => {
  const { complete } = scripted(reply([{ type: 'thinking', thinking: 'hmm' }]));
  assert.deepEqual(await runReviewerTurn(baseTurn(complete)), {
    type: 'error', error: { type: 'session', message: 'guardian review completed without an assessment payload', transient: false },
  });
});

test('the review deadline and external cancellation stop the turn', async () => {
  const hang = (_context: Context, signal: AbortSignal) => new Promise<AssistantMessage>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.deepEqual(await runReviewerTurn(baseTurn(scripted(hang).complete, { deadline: Date.now() + 30 })), { type: 'error', error: { type: 'timeout' } });
  const controller = new AbortController();
  const pending = runReviewerTurn(baseTurn(scripted(hang).complete, { signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await pending, { type: 'error', error: { type: 'cancelled' } });
});

test('the reviewer prompt carries Codex policy, reviewer permissions and inherited instructions', () => {
  const { systemPrompt, userContent } = buildReviewerPrompt({
    extraPolicy: 'Never delete Railway volumes.',
    contextFiles: [{ path: '/repo/AGENTS.md', content: 'Use rg.' }],
    cwd: '/repo', date: '2026-10-17', timezone: 'America/New_York',
    request: ['REQUEST\n'],
  });
  assert.ok(systemPrompt.startsWith('You are judging one planned coding-agent action.'));
  assert.ok(systemPrompt.includes('## Environment Profile') && systemPrompt.includes('Never delete Railway volumes.'));
  assert.ok(systemPrompt.includes('\n\nYou may use read-only tool checks'));
  assert.ok(systemPrompt.includes('<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`'));
  assert.ok(systemPrompt.includes('Approval policy is currently never.'));
  assert.deepEqual(userContent, [
    '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nUse rg.\n</INSTRUCTIONS>',
    '<environment_context>\n  <cwd>/repo</cwd>\n  <shell>bash</shell>\n  <current_date>2026-10-17</current_date>\n  <timezone>America/New_York</timezone>\n</environment_context>',
    'REQUEST\n',
  ]);
  assert.equal(EXEC_COMMAND_TOOL.name, 'exec_command');
});

test('read-only commands run under Seatbelt without write access', { skip: process.platform !== 'darwin' && 'Seatbelt is macOS-only' }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-reviewer-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await runReadOnlyCommand('echo visible', dir, AbortSignal.timeout(10_000)), 'visible\n\nexit code: 0');
  const denied = await runReadOnlyCommand('echo nope > out.txt', dir, AbortSignal.timeout(10_000));
  assert.match(denied, /Operation not permitted[\s\S]*exit code: 1$/);
  const huge = await runReadOnlyCommand('yes guardian | head -c 50000000', dir, AbortSignal.timeout(20_000));
  assert.ok(huge.length < 12_000 && huge.endsWith('exit code: 0'), 'huge output is bounded');
});
