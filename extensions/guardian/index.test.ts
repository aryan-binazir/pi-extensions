import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { withPi } from '../../tests/pi-session.ts';
import guardian from './index.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX } from './review/context.ts';

const darwin = { skip: process.platform !== 'darwin' && 'Seatbelt is macOS-only' };

function writeConfig(agentDir: string, config: Record<string, unknown>) {
  mkdirSync(join(agentDir, 'guardian'), { recursive: true });
  writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify(config));
}

const contextText = (context: TranscriptContext) => JSON.stringify(context.messages);
const toolResults = (messages: readonly { role: string }[]) => messages.filter(message => message.role === 'toolResult') as unknown as { toolName: string; isError: boolean; content: { text?: string }[] }[];

function outsideDir(t: test.TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-e2e-outside-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('escalations go to the configured reviewer model with Codex policy, Railway deny, transcript and action', async t => {
  const outside = outsideDir(t);
  const target = join(outside, 'escalated.txt');
  const requests: { main: string[]; reviewer: string[] } = { main: [], reviewer: [] };
  await withPi({ extensions: [guardian], responses: [
    context => {
      requests.main.push(contextText(context));
      return fauxAssistantMessage(fauxToolCall('bash', { command: `echo hi > ${target}`, sandbox_permissions: 'require_escalated', justification: 'Write the outside file?' }));
    },
    context => {
      requests.reviewer.push(contextText(context));
      return fauxAssistantMessage('{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Writes outside the workspace without approval."}');
    },
    context => { requests.main.push(contextText(context)); return fauxAssistantMessage('Stopped.'); },
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Please prepare the outside file.');
    const [result] = toolResults(session.messages);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text ?? '', /This action was rejected due to unacceptable risk\.\nReason: Writes outside the workspace without approval\./);
    assert.ok(!existsSync(target));
  });
  assert.equal(requests.reviewer.length, 1);
  const reviewer = requests.reviewer[0];
  for (const expected of ['You are judging one planned coding-agent action.', '## Environment Profile', 'Railway Databases (absolute deny)',
    "<permissions instructions>", '[1] user: Please prepare the outside file.', '>>> APPROVAL REQUEST START', '\\"sandbox_permissions\\": \\"require_escalated\\"',
    'Write the outside file?']) {
    assert.ok(reviewer.includes(expected), `reviewer request is missing ${expected}`);
  }
  assert.ok(requests.main[0].includes('<permissions_instructions>'), 'the main agent receives Codex permission instructions');
  assert.ok(requests.main[0].includes('`approvals_reviewer` is `auto_review`'));
});

test('an approved escalation runs outside the sandbox', darwin, async t => {
  const outside = outsideDir(t);
  const target = join(outside, 'approved.txt');
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo approved > ${target}`, sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('{"outcome":"allow"}'),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Write it.');
    assert.equal(readFileSync(target, 'utf8'), 'approved\n');
  });
});

test('ordinary commands run in the sandbox without a review call', darwin, async t => {
  const outside = outsideDir(t);
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo ok > inside.txt; echo no > ${outside}/x.txt` })),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    // The scratch directory lives under $TMPDIR, which the default sandbox may write.
    writeConfig(agentDir, { sandbox: { excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Go.');
    assert.equal(readFileSync(join(cwd, 'inside.txt'), 'utf8'), 'ok\n');
    assert.ok(!existsSync(join(outside, 'x.txt')));
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /Operation not permitted/);
  });
});

test('Railway destructive commands are forbidden before any review', async () => {
  let reviews = 0;
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'railway volume delete pg-data', sandbox_permissions: 'require_escalated' })),
    () => { reviews++; return fauxAssistantMessage('Stopped.'); },
  ] }, async ({ session }) => {
    await session.prompt('Clean up Railway.');
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /destructive Railway operations are permanently blocked/);
  });
  assert.equal(reviews, 1, 'only the main agent responds after the rejection');
});

test('an unavailable reviewer fails closed without a UI', async () => {
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'true', sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('Stopped.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: 'nowhere', model: 'missing', reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Go.');
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /Automatic approval review failed: reviewer model nowhere\/missing is not available/);
  });
});

const fakeWrite = (pi: ExtensionAPI) => pi.registerTool({
  name: 'write', label: 'write', description: 'write a file',
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  async execute(_id, { path, content }, _signal, _update, ctx) {
    writeFileSync(resolve(ctx.cwd, path), content);
    return { content: [{ type: 'text', text: 'written' }], details: undefined };
  },
});

test('writes outside writable roots are reviewed; inside writes are not', async t => {
  const outside = outsideDir(t);
  let reviewer = '';
  await withPi({ extensions: [guardian, fakeWrite], responses: [
    fauxAssistantMessage([fauxToolCall('write', { path: 'inside.txt', content: 'in' }), fauxToolCall('write', { path: join(outside, 'out.txt'), content: 'out' })]),
    context => { reviewer = contextText(context); return fauxAssistantMessage('{"outcome":"allow"}'); },
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' }, sandbox: { excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Write both.');
    assert.equal(readFileSync(join(cwd, 'inside.txt'), 'utf8'), 'in');
    assert.equal(readFileSync(join(outside, 'out.txt'), 'utf8'), 'out');
  });
  assert.ok(reviewer.includes('\\"tool\\": \\"write\\"') && reviewer.includes('out.txt') && !reviewer.includes('inside.txt\\"\\n  ]'));
});

test('/guardian approve records a trusted manual approval of the last denied action', async () => {
  let secondReview = '';
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'git push origin main', sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('{"outcome":"deny","rationale":"Pushes to main."}'),
    fauxAssistantMessage('Denied.'),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'git push origin main', sandbox_permissions: 'require_escalated' })),
    context => { secondReview = contextText(context); return fauxAssistantMessage('{"outcome":"deny","rationale":"still no remote"}'); },
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Push it.');
    await session.prompt('/guardian approve');
    await session.waitForIdle();
  });
  assert.ok(secondReview.includes(`developer: ${MANUAL_APPROVAL_DEVELOPER_PREFIX}`), 'the reviewer sees the approval as a trusted developer entry');
  assert.ok(secondReview.includes('git push origin main'));
});

test('a claude-cli reviewer runs claude -p and its verdict decides the escalation', darwin, async t => {
  const outside = outsideDir(t);
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-fake-claude-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const record = join(bin, 'record.json');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
let stdin = '';
process.stdin.on('data', chunk => { stdin += chunk; }).on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{"outcome":"allow"}' }));
});
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const target = join(outside, 'claude.txt');
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo claude > ${target}`, sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: 'claude-cli', model: 'claude-opus-5-5', reasoning: 'high' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Write it with Claude reviewing.');
    assert.equal(readFileSync(target, 'utf8'), 'claude\n');
  });
  const recorded = JSON.parse(readFileSync(record, 'utf8'));
  assert.ok(recorded.argv.includes('--safe-mode') && recorded.argv.includes('claude-opus-5-5'));
  assert.ok(recorded.argv[recorded.argv.indexOf('--system-prompt') + 1].startsWith('You are judging one planned coding-agent action.'));
  assert.ok(recorded.stdin.includes('[1] user: Write it with Claude reviewing.') && recorded.stdin.includes('>>> APPROVAL REQUEST START'));
});
