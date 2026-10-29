import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { withPi } from '../../tests/pi-session.ts';
import { APPROVAL_AUDIT_ENTRY_TYPE, type ApprovalAuditEntry } from './approvals.ts';
import guardian from './index.ts';

test('default bash runs on the host only after the configured model approves it', async () => {
  let target = '';
  let reviewed = false;
  let mainPermissions = '';
  let reviewerPrompt = '';
  await withPi({ extensions: [guardian], responses: [
    context => {
      mainPermissions = JSON.stringify(context.messages).match(/<permissions_instructions>(.*?)<\/permissions_instructions>/s)?.[1] ?? '';
      return fauxAssistantMessage(fauxToolCall('bash', { command: 'mkdir -p .git && printf approved > .git/host-proof' }));
    },
    context => {
      reviewerPrompt = JSON.stringify(context.messages);
      reviewed = reviewerPrompt.includes('You are judging one planned coding-agent action.');
      assert.equal(existsSync(target), false);
      return fauxAssistantMessage('{"outcome":"allow"}');
    },
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir, cwd }, provider) => {
    target = join(cwd, '.git', 'host-proof');
    mkdirSync(join(agentDir, 'guardian'), { recursive: true });
    writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({
      reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' },
    }));
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Write the host proof.');
    assert.equal(reviewed, true, 'the configured model must review the ordinary command');
    assert.equal(readFileSync(target, 'utf8'), 'approved');
    const records = session.sessionManager.getBranch().flatMap(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE
      ? [entry.data as ApprovalAuditEntry] : []);
    assert.equal(records.length, 1);
    assert.equal(records[0].decider, 'auto_review');
    assert.equal(records[0].verdict, 'approved');
    assert.match(mainPermissions, /host/);
    assert.doesNotMatch(mainPermissions, /require_escalated|unless-trusted|Network access is restricted/);
    assert.match(reviewerPrompt, /Commands and file changes run on the host/);
    assert.doesNotMatch(reviewerPrompt, /The coding-agent is running in a sandbox/);
    assert.match(reviewerPrompt, /`sandbox_mode` is `read-only`/);
  });
});

for (const tool of ['write', 'edit'] as const) test(`default workspace ${tool} is reviewed and a denial leaves the file untouched`, async () => {
  let target = '';
  let reviewed = false;
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall(tool, tool === 'write'
      ? { path: 'existing.txt', content: 'changed' }
      : { path: 'existing.txt', edits: [{ oldText: 'original', newText: 'changed' }] })),
    context => {
      reviewed = JSON.stringify(context.messages).includes('You are judging one planned coding-agent action.');
      return fauxAssistantMessage('{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Keep the original file."}');
    },
    fauxAssistantMessage('Stopped.'),
  ], configure: ({ agentDir, cwd }, provider) => {
    target = join(cwd, 'existing.txt');
    writeFileSync(target, 'original');
    mkdirSync(join(agentDir, 'guardian'), { recursive: true });
    writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({
      reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' },
    }));
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Replace the file.');
    assert.equal(reviewed, true, 'workspace writes must reach the configured reviewer');
    assert.equal(readFileSync(target, 'utf8'), 'original');
    const result = session.messages.find(message => message.role === 'toolResult');
    assert.equal(result?.role === 'toolResult' && result.isError, true);
  });
});

test('approved host writes and edits use the normal filesystem', async () => {
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('write', { path: '.git/host-proof', content: 'original' })),
    fauxAssistantMessage('{"outcome":"allow"}'),
    fauxAssistantMessage(fauxToolCall('edit', { path: '.git/host-proof', edits: [{ oldText: 'original', newText: 'edited' }] })),
    fauxAssistantMessage('{"outcome":"allow"}'),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    mkdirSync(join(agentDir, 'guardian'), { recursive: true });
    writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({
      reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' },
    }));
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Write and edit the proof.');
    assert.equal(readFileSync(join(cwd, '.git', 'host-proof'), 'utf8'), 'edited');
    const records = session.sessionManager.getBranch().flatMap(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE
      ? [entry.data as ApprovalAuditEntry] : []);
    assert.deepEqual(records.map(record => [record.decider, record.verdict]), [['auto_review', 'approved'], ['auto_review', 'approved']]);
  });
});

test('a rejected ordinary host command never executes', async () => {
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'mkdir -p rejected && touch rejected/marker' })),
    fauxAssistantMessage('{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Not authorized."}'),
    fauxAssistantMessage('Stopped.'),
  ], configure: ({ agentDir }, provider) => {
    mkdirSync(join(agentDir, 'guardian'), { recursive: true });
    writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({
      reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' },
    }));
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Run the command.');
    assert.equal(existsSync(join(cwd, 'rejected')), false);
    const result = session.messages.find(message => message.role === 'toolResult');
    assert.equal(result?.role === 'toolResult' && result.isError, true);
  });
});
