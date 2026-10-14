import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import todo from '../extensions/todo/index.ts';
import { withPi } from './pi-session.ts';

test('the shared Pi session executes scripted extension tools and removes its workspace', async () => {
  let workspace = '';
  await withPi({ extensions: [todo], responses: [
    fauxAssistantMessage(fauxToolCall('todo_write', { todos: [{ content: 'Scripted task', status: 'pending' }] })),
    fauxAssistantMessage('Done'),
  ] }, async ({ session, cwd }) => {
    workspace = cwd;
    await session.prompt('Record the task');
    assert.ok(session.messages.some(message => message.role === 'toolResult' && message.toolName === 'todo_write'));
    assert.match(JSON.stringify(session.sessionManager.getBranch()), /Scripted task/);
  });
  await assert.rejects(access(workspace), { code: 'ENOENT' });
});

test('a failing test still awaits extension shutdown, restores the environment and removes its workspace', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  let workspace = '', stopped = false;
  await assert.rejects(withPi({ extensions: [pi => {
    pi.on('session_shutdown', async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await access(workspace);
      stopped = true;
    });
  }] }, async ({ cwd }) => {
    workspace = cwd;
    throw new Error('test failed');
  }), /test failed/);
  assert.equal(stopped, true);
  assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
  await assert.rejects(access(workspace), { code: 'ENOENT' });
});

test('shutdown errors fail the fixture after its temporary directories are removed', async () => {
  let workspace = '';
  await assert.rejects(withPi({ extensions: [pi => {
    pi.on('session_shutdown', () => { throw new Error('shutdown failed'); });
  }] }, async ({ cwd }) => { workspace = cwd; }), /shutdown failed/);
  await assert.rejects(access(workspace), { code: 'ENOENT' });
});
