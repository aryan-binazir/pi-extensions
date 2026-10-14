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
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  let workspace = '', stopped = false;
  await assert.rejects(withPi({ extensions: [pi => {
    pi.on('session_shutdown', async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await access(workspace);
      stopped = true;
    });
  }] }, async ({ cwd }) => {
    workspace = cwd;
    assert.equal(process.env.CLAUDE_CONFIG_DIR, `${cwd}/claude`);
    throw new Error('test failed');
  }), /test failed/);
  assert.equal(stopped, true);
  assert.equal(process.env.PI_CODING_AGENT_DIR, previous.agent);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, previous.claude);
  await assert.rejects(access(workspace), { code: 'ENOENT' });
});

test('shutdown errors fail the fixture after its temporary directories are removed', async () => {
  let workspace = '';
  await assert.rejects(withPi({ extensions: [pi => {
    pi.on('session_shutdown', () => { throw new Error('shutdown failed'); });
  }] }, async ({ cwd }) => { workspace = cwd; }), /shutdown failed/);
  await assert.rejects(access(workspace), { code: 'ENOENT' });
});

test('callback and shutdown failures retain both errors after cleanup', async () => {
  let workspace = '';
  const failure = new Error('callback failed');
  await assert.rejects(withPi({ extensions: [pi => {
    pi.on('session_shutdown', () => { throw new Error('shutdown failed'); });
  }] }, async ({ cwd }) => { workspace = cwd; throw failure; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], failure);
    assert.match(error.errors[1].message, /shutdown failed/);
    return true;
  });
  await assert.rejects(access(workspace), { code: 'ENOENT' });
});

test('runtime replacement consumes the remaining faux responses and exposes the live session', async () => withPi({
  responses: [fauxAssistantMessage('Before replacement'), fauxAssistantMessage('After replacement')],
}, async fixture => {
  const first = fixture.session;
  await first.prompt('First turn');
  await fixture.runtime.newSession();
  assert.notEqual(fixture.session, first);
  await fixture.session.prompt('Second turn');
  assert.match(JSON.stringify(fixture.session.messages), /After replacement/);
  assert.equal(fixture.provider.state.callCount, 2);
}));
