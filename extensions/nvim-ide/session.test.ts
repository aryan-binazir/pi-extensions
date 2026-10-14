import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { withPi } from '../../tests/pi-session.ts';
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import nvimIde from './index.ts';
import { fakeIde, token, until } from './test-support.ts';

for (const composition of ['isolated', 'package'] as const) test(`real Pi ${composition} requests persist only submitted editor snapshots`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-editor-snapshot-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  let initialized = false;
  const ide = fakeIde(socket => socket.on('message', raw => {
    if (JSON.parse(raw.toString()).method === 'notifications/initialized') initialized = true;
  }));
  try {
    await once(ide.server, 'listening');
    await mkdir(join(cwd, 'ide'));
    await writeFile(join(cwd, 'ide', `${ide.port()}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: [cwd], ideName: 'Neovim', authToken: token }));
    process.env.CLAUDE_CONFIG_DIR = cwd;
    const requests: string[] = [];
    const response = (context: TranscriptContext) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage('Acknowledged'); };
    await withPi({ cwd, extensions: composition === 'isolated' ? [nvimIde] : undefined,
      settings: { compaction: { enabled: false }, retry: { enabled: false }, ...(composition === 'package' ? { packages: [join(import.meta.dirname, '../..')] } : {}) },
      responses: [response, response],
      configure: (_services, provider) => { process.env.CLAUDE_CONFIG_DIR = cwd; return { model: provider.getModel() }; },
    }, async ({ session }) => {
      const manager = session.sessionManager;
      session.setActiveToolsByName(['nvim_context', 'subagent', 'workflow']);
      await until(() => initialized);
      const select = async (text: string) => {
        ide.broadcast('selection_changed', { filePath: join(cwd, 'source.ts'), text, selection: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length }, isEmpty: false } });
        const runner = session.extensionRunner;
        await session.getToolDefinition('nvim_context')!.execute('barrier', {}, undefined, undefined, runner.createToolContext('barrier', undefined));
      };
      await select('NEVER_SUBMITTED');
      assert.ok(!JSON.stringify(manager.getBranch()).includes('NEVER_SUBMITTED'));
      await select('INCLUDED_IN_REQUEST');
      await session.prompt('Use the current selection');
      assert.equal(requests.length, 1);
      assert.ok(requests[0].includes('INCLUDED_IN_REQUEST'));
      if (composition === 'package') {
        assert.ok(requests[0].includes('Default profile'));
      }
      assert.ok(!requests[0].includes('NEVER_SUBMITTED'));
      await select('AFTER_REQUEST_UNSUBMITTED');
      const persisted = JSON.stringify(SessionManager.open(manager.getSessionFile()!).getBranch());
      assert.ok(persisted.includes('INCLUDED_IN_REQUEST'));
      assert.ok(!persisted.includes('NEVER_SUBMITTED'));
      assert.ok(!persisted.includes('AFTER_REQUEST_UNSUBMITTED'));
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      await session.prompt('Continue without an editor');
      assert.equal(requests.length, 2);
      assert.ok(!session.systemPrompt.includes('INCLUDED_IN_REQUEST'));
      assert.ok(!session.systemPrompt.includes('<editor_context>'));
    });
  } finally {
    await ide.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the follow preference survives real Pi /new, /resume, /fork and /reload', async () => {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const followKey = Symbol.for('pi-interactive:nvim-ide.follow.v1');
  delete registry[followKey];
  const notices: string[] = [];
  const extension = fileURLToPath(new URL('./index.ts', import.meta.url));
  try {
    await withPi({ settings: { extensions: [extension] }, sessionStartEvent: { type: 'session_start', reason: 'startup' },
      bind: session => ({ uiContext: { ...session.extensionRunner.createContext().ui, notify: message => notices.push(message) }, mode: 'tui' }),
    }, async ({ runtime }) => {
      const follow = async (args = '') => {
        const runner = runtime.session.extensionRunner;
        await runner.getCommand('vim')!.handler(`follow ${args}`.trim(), runner.createCommandContext());
        return notices.at(-1);
      };
      const userEntry = () => runtime.session.sessionManager.appendMessage({ role: 'user', content: 'persist this session', timestamp: Date.now() });
      assert.equal(await follow('off'), 'Editor follows pi edits: off');
      const entry = userEntry();
      const first = runtime.session.sessionFile!;
      await runtime.newSession();
      assert.equal(await follow(), 'Editor follows pi edits: off', '/new');
      await runtime.switchSession(first);
      assert.equal(await follow(), 'Editor follows pi edits: off', '/resume');
      await runtime.fork(entry);
      assert.equal(await follow(), 'Editor follows pi edits: off', '/fork');
      await runtime.session.reload();
      assert.equal(await follow(), 'Editor follows pi edits: off', '/reload');
      assert.equal(await follow('on'), 'Editor follows pi edits: on');
      await runtime.newSession();
      assert.equal(await follow(), 'Editor follows pi edits: on', 'turning follow back on also persists');
    });
  } finally { delete registry[followKey]; }
});
