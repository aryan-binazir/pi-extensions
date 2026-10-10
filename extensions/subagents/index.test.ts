import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InteractiveMode, ExtensionEditorComponent, CustomEditor, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import type { Host } from './test-support.ts';
import { until, withHost } from './test-support.ts';

const echoArgs = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})}],usage:{input:3,output:4}}}));`;

function assertChildTools(child: {args: string[]}, tools: string[]) {
  assert.ok(child.args.includes('--tools'));
  assert.equal(child.args[child.args.indexOf('--tools') + 1], tools.join(','));
  assert.ok(child.args.includes('--no-extensions'));
  assert.ok(!child.args.includes('-e'), 'no mandatory child extension');
}

test('workflow registration requires exact source approval and protects sensitive reads', async () =>
  withHost({prefix: 'workflow-extension-', ctx: {hasUI: false, model: undefined}, start: false}, async ({cwd, ctx, execute}) => {
    await assert.rejects(execute('workflow', {source: 'return 1;'}), /approval/);
    ctx.hasUI = true;
    await writeFile(join(cwd, '.env'), 'SYNTHETIC_SECRET');
    ctx.ui.editor = async () => 'return 2;';
    await assert.rejects(execute('workflow', {source: 'return 1;'}), /approv/i);
    ctx.ui.editor = async (_title: string, source: string) => source;
    await assert.rejects(execute('workflow', {source: 'return await api.readFile(".env");'}), /sensitive/);
  }));

test('registered background tool launches tool-limited Pi and pushes completion to its parent', async () =>
  withHost({prefix: 'subagent-extension-', pi: echoArgs, ctx: {hasUI: false}}, async ({cwd, execute, notifications, tools}) => {
    const response = await execute('subagent', {task: 'Read synthetic checkout', preset: 'reader'});
    const guidance = tools.get('subagent').promptGuidelines;
    assert.equal(JSON.parse(response.content[0].text).notification, guidance[0]);
    const completion = await until(() => notifications[0], 'the completion notification', 5000);
    assert.deepEqual(completion.options, {triggerTurn: true, deliverAs: 'followUp'});
    assert.equal(completion.type, 'subagent-complete');
    assert.equal(completion.task.status, 'succeeded');
    assert.equal(completion.task.id, response.details.id);
    assert.deepEqual(completion.task.usage, {input: 3, output: 4});
    const child = JSON.parse(completion.task.output);
    assert.equal(child.cwd, await realpath(cwd));
    assertChildTools(child, ['read', 'grep', 'find', 'ls']);
    assert.ok(child.args.includes('--no-session'));
    assert.equal(child.args.at(-1), 'Read synthetic checkout');
  }));

test('RPC UI approves extensions once per real spawn and reauthorizes cached workflow stages', async () =>
  withHost({
    prefix: 'workflow-rpc-',
    pi: `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));`,
  }, async ({cwd, ctx, execute, notifications}) => {
    const approvals: string[] = [];
    let allowExtensions = true;
    ctx.ui.confirm = async (title: string) => { approvals.push(title); return title.includes('child extensions') ? allowExtensions : true; };
    await writeFile(join(cwd, 'trusted.ts'), 'export default () => {};');
    const source = `return await api.spawn({task:'read',preset:'reader',extensions:[${JSON.stringify(join(cwd, 'trusted.ts'))}]},'read');`;
    const workflow = () => execute('workflow', {source});
    await workflow();
    assert.equal(notifications.length, 0, 'workflow owns its child result');
    assert.equal((await execute('subagent_status')).details.length, 1);
    assert.equal(approvals.filter(title => title.includes('child extensions')).length, 1);
    allowExtensions = false;
    await assert.rejects(workflow(), /Child extension loading was not approved/);
    assert.equal((await execute('subagent_status')).details.length, 1, 'rejected replay must not launch a child');
    allowExtensions = true;
    await workflow();
    assert.equal((await execute('subagent_status')).details.length, 1, 'approved replay must reuse the cached child');
    assert.equal(notifications.length, 0);
    assert.equal(approvals.filter(title => title.includes('child extensions')).length, 3);
  }));

test('children keep running until a committed shutdown reaps them', async () =>
  withHost({
    prefix: 'subagent-switch-',
    pi: `console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:String(process.pid)}}));setInterval(()=>{},1000);`,
    ctx: {hasUI: false},
  }, async ({execute, shutdown}) => {
    const launch = () => execute('subagent', {task: 'wait', preset: 'reader'});
    await launch();
    await launch();
    const status = async () => (await execute('subagent_status')).details;
    const running = await until(async () => {
      const tasks = await status();
      return tasks.every((task: {output: string}) => task.output) ? tasks : undefined;
    }, 'both children to report their pid', 5000);
    assert.equal(running.length, 2);
    assert.ok(running.every((task: {status: string; output: string}) => task.status === 'running' && Number(task.output) > 0));
    const pids = running.map((task: {output: string}) => Number(task.output));
    await shutdown({reason: 'resume'});
    assert.ok((await status()).every((task: {status: string}) => task.status === 'cancelled'));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  }));

test('standalone registered subagents and workflows inherit active builtins and workspace without auto mode', async () => {
  let active = ['read', 'subagent', 'workflow'];
  await withHost({
    prefix: 'standalone-subagents-', pi: echoArgs, tools: () => active,
    before: host => writeFile(join(host.cwd, 'input'), 'safe'),
  }, async ({cwd, execute}) => {
    const direct = (params: Record<string, unknown>) => execute('subagent', params);
    const workflow = (source: string) => execute('workflow', {source});
    const directChild = async (preset?: string) => {
      const response = await direct({task: 'valid direct child', preset});
      const task = await until(async () => {
        const value = (await execute('subagent_status', {id: response.details.id})).details;
        assert.ok(['queued', 'running', 'succeeded'].includes(value.status), JSON.stringify(value));
        return value.status === 'succeeded' ? value : undefined;
      }, 'the direct child to succeed', 5000);
      return JSON.parse(task.output);
    };
    for (const tool of ['write', 'bash']) {
      await assert.rejects(direct({task: 'escalate', tools: [tool]}), /exceed parent permissions/);
      await assert.rejects(workflow(`return await api.spawn({task:'escalate',tools:['${tool}']},'${tool}');`), /exceed parent permissions/);
    }
    await assert.rejects(direct({task: 'escape', cwd: tmpdir()}), /outside parent workspace/);
    await assert.rejects(workflow(`return await api.spawn({task:'escape',cwd:${JSON.stringify(tmpdir())}},'escape');`), /escapes workflow cwd/);
    for (const preset of [undefined, 'reader', 'writer']) {
      const response = await workflow(`return await api.spawn(${JSON.stringify({task: 'valid', preset})},'valid');`);
      const child = JSON.parse(response.details.output);
      assertChildTools(child, ['read']);
      assertChildTools(await directChild(preset), ['read']);
      assert.equal(child.cwd, await realpath(cwd));
    }
    active = ['subagent', 'workflow'];
    for (const preset of [undefined, 'reader', 'writer']) {
      const response = await workflow(`return await api.spawn(${JSON.stringify({task: 'reason only', preset})},'reason');`);
      assertChildTools(JSON.parse(response.details.output), []);
      assertChildTools(await directChild(preset), []);
    }
    await assert.rejects(workflow('return await api.readFile("input");'), /outside parent permissions/);
  });
});


test('a child launches with discovery disabled and receives a dash-prefixed brief verbatim after --', async () =>
  withHost({prefix: 'subagent-discovery-', pi: echoArgs, ctx: {hasUI: false}}, async ({execute, notifications}) => {
    await execute('subagent', {task: '--version', preset: 'reader'});
    const completion = await until(() => notifications[0], 'the completion notification', 5000);
    const argv: string[] = JSON.parse(completion.task.output).args;
    assert.deepEqual(argv.filter(arg => arg.startsWith('--no-') || arg === '--').concat(argv.at(-1)!),
      ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--', '--version']);
  }));

initTheme('dark', false);

function interactiveUI({ctx}: Host) {
  const mode: any = Object.create(InteractiveMode.prototype);
  let draft = 'parent draft';
  mode.editor = {getText: () => draft, setText: (text: string) => { draft = text; }, focused: true};
  mode.focus = mode.editor;
  mode.editorContainer = new Container();
  mode.editorContainer.addChild(mode.editor);
  mode.keybindings = {matches: () => false};
  Object.defineProperty(mode, 'settingsManager', {value: {getExternalEditorCommand: () => undefined}});
  mode.ui = {
    terminal: {rows: 24, columns: 80, write() {}},
    setFocus: (component: any) => { mode.focus.focused = false; mode.focus = component; component.focused = true; },
    requestRender() {}, getSize: () => ({columns: 80, rows: 24}),
  };
  ctx.mode = 'tui';
  ctx.ui.editor = mode.showExtensionEditor.bind(mode);
  ctx.ui.custom = mode.showExtensionCustom.bind(mode);
  ctx.ui.confirm = mode.showExtensionConfirm.bind(mode);
  ctx.ui.getEditorText = mode.createExtensionUIContext().getEditorText;
  ctx.ui.setEditorText = mode.createExtensionUIContext().setEditorText;
  return mode;
}

for (const tool of ['workflow', 'subagent']) {
  for (const stop of ['timeout', 'owner', 'cancel all', 'shutdown']) {
    test(`${tool} approval closes and restores main editor focus on ${stop}`, async () =>
      withHost({prefix: 'subagent-dialog-'}, async host => {
        const mode = interactiveUI(host);
        const controller = new AbortController();
        const extension = join(host.cwd, 'child.ts');
        await writeFile(extension, 'export default () => {};');
        const params = tool === 'workflow' ? {source: 'return 1;'} : {task: 'read', preset: 'reader', extensions: [extension]};
        const run = host.execute(tool, {...params, timeout: stop === 'timeout' ? 150 : 5000}, controller.signal).then(
          () => { throw new Error('Unapproved operation succeeded'); }, error => error,
        );
        await until(() => mode.focus !== mode.editor, 'the approval to mount');
        const dialog = mode.focus;
        assert.equal(dialog.focused, true);
        if (stop === 'owner') controller.abort();
        if (stop === 'cancel all') await host.execute('subagent_cancel', {id: 'all'});
        if (stop === 'shutdown') await host.shutdown();
        const error = await run;
        assert.match(String(error), /aborted|deadline|cancelled|shut down/i);
        try {
          assert.deepEqual(mode.editorContainer.children, [mode.editor]);
          assert.equal(mode.focus, mode.editor);
          assert.equal(mode.editor.focused, true);
          assert.equal(mode.editor.getText(), 'parent draft');
          if (dialog instanceof ExtensionEditorComponent) {
            dialog.handleInput('\r');
            await Promise.resolve();
            assert.equal(mode.focus, mode.editor, 'late submission cannot reopen a dialog');
          }
          assert.deepEqual((await host.execute('subagent_status')).details, []);
        } finally {
          dialog.handleInput('\x1b');
        }
      }));
  }
}

for (const edit of ['unchanged', 'changed', 'cancelled']) {
  test(`TUI workflow source review ${edit} preserves explicit approval`, async () =>
    withHost({prefix: 'workflow-source-'}, async host => {
      const mode = interactiveUI(host);
      host.ctx.ui.custom = async (factory: any) => {
        const review = mode.showExtensionCustom(factory);
        const dialog = await until(() => mode.focus instanceof ExtensionEditorComponent && mode.focus, 'source review');
        assert.equal(dialog.editor.getText(), 'return 1;');
        assert.equal(dialog.editor.focused, true);
        if (edit === 'changed') dialog.handleInput('x');
        dialog.handleInput(edit === 'cancelled' ? '\x1b' : '\r');
        return review;
      };
      let confirmations = 0;
      host.ctx.ui.confirm = async () => { confirmations++; return true; };
      const run = host.execute('workflow', {source: 'return 1;'});
      if (edit === 'unchanged') {
        assert.equal((await run).details, 1);
        assert.equal(confirmations, 1);
      } else {
        await assert.rejects(run, /explicit source approval/);
        assert.equal(confirmations, 0);
      }
      assert.equal(mode.focus, mode.editor);
    }));
}

test('cancellation before custom source review mounts retains main editor focus', async () =>
  withHost({prefix: 'workflow-premount-'}, async host => {
    const mode = interactiveUI(host);
    const controller = new AbortController();
    host.ctx.ui.custom = (factory: any) => mode.showExtensionCustom(async (...args: any[]) => {
      controller.abort();
      return factory(...args);
    });
    await assert.rejects(host.execute('workflow', {source: 'return 1;'}, controller.signal), /aborted/);
    await Promise.resolve();
    assert.deepEqual(mode.editorContainer.children, [mode.editor]);
    assert.equal(mode.focus, mode.editor);
  }));

for (const approval of ['execution', 'replay', 'cached child extensions']) {
  for (const stop of ['timeout', 'owner']) {
    test(`workflow ${approval} confirmation restores main editor focus on ${stop}`, async () =>
      withHost({prefix: 'workflow-confirm-', pi: echoArgs}, async host => {
        const mode = interactiveUI(host);
        const extension = join(host.cwd, 'child.ts');
        await writeFile(extension, 'export default () => {};');
        const source = approval === 'cached child extensions'
          ? `return await api.spawn({task:'read',preset:'reader',extensions:[${JSON.stringify(extension)}]},'stage');`
          : "return await api.checkpoint('stage', async () => 1);";
        host.ctx.ui.custom = async (factory: any) => {
          const review = mode.showExtensionCustom(factory);
          const dialog = await until(() => mode.focus instanceof ExtensionEditorComponent && mode.focus, 'source review');
          dialog.handleInput('\r');
          return review;
        };
        host.ctx.ui.confirm = async () => true;
        if (approval !== 'execution') await host.execute('workflow', {source});
        const before = (await host.execute('subagent_status')).details.length;
        host.ctx.ui.confirm = (title: string, message: string, opts: any) => {
          const wait = approval === 'execution' ? title.startsWith('Execute')
            : approval === 'replay' ? title.startsWith('Replay') : title.startsWith('Approve workflow child');
          return wait ? mode.showExtensionConfirm(title, message, opts) : Promise.resolve(true);
        };
        const controller = new AbortController();
        const run = host.execute('workflow', {source, timeout: stop === 'timeout' ? 1000 : 5000}, controller.signal).then(
          () => { throw new Error('Unapproved operation succeeded'); }, error => error,
        );
        const dialog = await until(() => mode.extensionSelector, 'workflow confirmation');
        assert.equal(mode.focus, dialog);
        if (stop === 'owner') controller.abort();
        assert.match(String(await run), /aborted|approval declined/);
        try {
          assert.deepEqual(mode.editorContainer.children, [mode.editor]);
          assert.equal(mode.focus, mode.editor);
          assert.equal(mode.editor.getText(), 'parent draft');
          dialog.handleInput('\r');
          assert.equal((await host.execute('subagent_status')).details.length, before);
        } finally {
          dialog.handleInput('\x1b');
        }
      }));
  }
}


for (const trusted of [false, true, 'runtime']) {
  const settings = SettingsManager.inMemory({});
  test(`source review external editor respects ${trusted === true ? 'trusted project' : trusted || 'global'} settings`, async () =>
    withHost({prefix: 'workflow-external-', getSettings: typeof trusted === 'string' ? () => 'getSettings' in settings && typeof settings.getSettings === 'function' ? settings.getSettings() : {externalEditor: settings.getExternalEditorCommand()} : undefined}, async host => {
      const script = join(host.cwd, 'editor.cjs');
      await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(join(host.cwd, 'editor-used'))}, process.argv[2]);`);
      const command = `${process.execPath} ${script}`;
      if (typeof trusted === 'string') settings.applyOverrides({externalEditor: `${command} runtime`});
      await writeFile(join(host.agentDir, 'settings.json'), JSON.stringify({externalEditor: `${command} global`}));
      await mkdir(join(host.cwd, '.pi'));
      await writeFile(join(host.cwd, '.pi', 'settings.json'), JSON.stringify({externalEditor: `${command} project`}));
      const mode = interactiveUI(host);
      host.ctx.isProjectTrusted = () => trusted === true;
      let restarted = false;
      mode.ui.stop = () => {};
      mode.ui.start = () => { restarted = true; };
      mode.keybindings.matches = (data: string, action: string) => data === '\x07' && action === 'app.editor.external';
      host.ctx.ui.confirm = async () => true;
      const run = host.execute('workflow', {source: 'return 1;', timeout: 5000});
      const dialog = await until(() => mode.focus instanceof ExtensionEditorComponent && mode.focus, 'source review');
      dialog.handleInput('\x07');
      try {
        await until(() => restarted, 'the synthetic external editor to finish');
        assert.equal(await readFile(join(host.cwd, 'editor-used'), 'utf8'), trusted === true ? 'project' : trusted === 'runtime' ? 'runtime' : 'global');
        dialog.handleInput('\r');
        assert.equal((await run).details, 1);
      } finally {
        dialog.handleInput('\x1b');
        await run.catch(() => {});
      }
    }));
}

for (const firstTool of ['subagent', 'workflow']) {
  for (const stop of ['timeout', 'owner']) {
    test(`a ${firstTool} ${stop} leaves another admission approval usable`, async () =>
      withHost({prefix: 'subagent-overlap-', pi: echoArgs}, async host => {
        const mode = interactiveUI(host);
        const firstOwner = new AbortController(), secondOwner = new AbortController();
        const extension = join(host.cwd, 'child.ts');
        await writeFile(extension, 'export default () => {};');
        const child = {task: 'read', preset: 'reader', extensions: [extension]};
        let secondDialog: any;
        let confirmations = 0;
        host.ctx.ui.confirm = (title: string, message: string, opts: any) => {
          const confirmation = mode.showExtensionConfirm(title, message, opts);
          if (++confirmations === (firstTool === 'subagent' ? 2 : 1)) secondDialog = mode.extensionSelector;
          return confirmation;
        };
        const first = host.execute(firstTool, {...(firstTool === 'subagent' ? child : {source: 'return 1;'}), timeout: stop === 'timeout' ? 150 : 5000}, firstOwner.signal).catch(error => error);
        await until(() => mode.focus !== mode.editor, 'the first approval');
        const second = host.execute('subagent', {...child, timeout: 5000}, secondOwner.signal);
        try {
          if (stop === 'owner') { await new Promise(resolve => setTimeout(resolve, 50)); firstOwner.abort(); }
          assert.match(String(await first), /aborted|deadline/);
          await until(() => secondDialog, 'the remaining approval');
          assert.equal(mode.focus, secondDialog, 'expiry must not dismiss the remaining approval');
          assert.deepEqual(mode.editorContainer.children, [secondDialog]);
          secondDialog.handleInput('\r');
          const launched = await second;
          const finished = await until(async () => {
            const task = (await host.execute('subagent_status', {id: launched.details.id})).details;
            return task.status === 'succeeded' ? task : undefined;
          }, 'the approved remaining child to finish');
          assert.equal(finished.status, 'succeeded');
        } finally {
          firstOwner.abort(); secondOwner.abort();
          await second.catch(() => {});
        }
      }));
  }
}

test('an admission expiring while queued leaves the active approval usable', async () =>
  withHost({prefix: 'subagent-queued-ui-', pi: echoArgs}, async host => {
    const mode = interactiveUI(host);
    const owner = new AbortController();
    const extension = join(host.cwd, 'child.ts');
    await writeFile(extension, 'export default () => {};');
    const child = {preset: 'reader', extensions: [extension]};
    const active = host.execute('subagent', {...child, task: 'active', timeout: 5000}, owner.signal);
    const dialog = await until(() => mode.extensionSelector, 'the active approval');
    try {
      await assert.rejects(host.execute('subagent', {...child, task: 'expired', timeout: 100}), /deadline/);
      assert.equal(mode.focus, dialog);
      assert.deepEqual(mode.editorContainer.children, [dialog]);
      dialog.handleInput('\r');
      const launched = await active;
      await until(async () => (await host.execute('subagent_status', {id: launched.details.id})).details.status === 'succeeded', 'the active child to finish');
      const tasks = (await host.execute('subagent_status')).details;
      assert.deepEqual(tasks.map((task: {task: string}) => task.task), ['active']);
      assert.equal(mode.focus, mode.editor);
    } finally {
      owner.abort();
      await active.catch(() => {});
    }
  }));

for (const stop of ['escape', 'owner', 'timeout', 'submit']) {
  test(`source review preserves a collapsed pasted draft on ${stop}`, async () =>
    withHost({prefix: 'workflow-paste-'}, async host => {
      const mode = interactiveUI(host);
      mode.editor = new CustomEditor(mode.ui, {borderColor: (text: string) => text, selectList: {selectedPrefix: (text: string) => text, selectedText: (text: string) => text, description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text}}, mode.keybindings);
      mode.editorContainer.clear();
      mode.editorContainer.addChild(mode.editor);
      mode.focus = mode.editor;
      const draft = 'pasted draft '.repeat(400);
      mode.editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
      assert.notEqual(mode.editor.getText(), draft);
      assert.equal(host.ctx.ui.getEditorText(), draft);
      const controller = new AbortController();
      host.ctx.ui.confirm = async () => true;
      const run = host.execute('workflow', {source: 'return 1;', timeout: stop === 'timeout' ? 100 : 5000}, controller.signal);
      const dialog = await until(() => mode.focus instanceof ExtensionEditorComponent && mode.focus, 'source review');
      if (stop === 'owner') controller.abort();
      else if (stop === 'escape') dialog.handleInput('\x1b');
      else if (stop === 'submit') dialog.handleInput('\r');
      if (stop === 'submit') assert.equal((await run).details, 1);
      else await assert.rejects(run);
      assert.equal(host.ctx.ui.getEditorText(), draft);
      assert.equal(mode.focus, mode.editor);
    }));
}

test('source review cancellation restores synchronously and preserves a replacement draft', async () =>
  withHost({prefix: 'workflow-replace-'}, async host => {
    const mode = interactiveUI(host);
    const controller = new AbortController();
    const run = host.execute('workflow', {source: 'return 1;', timeout: 5000}, controller.signal);
    const dialog = await until(() => mode.focus instanceof ExtensionEditorComponent && mode.focus, 'source review');
    controller.abort();
    assert.equal(mode.focus, mode.editor);
    host.ctx.ui.setEditorText('replacement draft');
    await assert.rejects(run);
    dialog.handleInput('\r');
    dialog.handleInput('\x1b');
    assert.equal(host.ctx.ui.getEditorText(), 'replacement draft');
  }));

test('the active panel caps its height, lists running children first, and fits narrow widths', async () =>
  withHost({prefix: 'subagent-panel-', pi: 'setInterval(()=>{},1000)'}, async ({ctx, execute}) => {
    let panel: ((tui: unknown, theme: unknown) => {render(width: number): string[]}) | undefined;
    ctx.ui.setWidget = (_key: string, value?: typeof panel) => { panel = value; };
    const theme = {fg: (_color: string, text: string) => `\x1b[34m${text}\x1b[39m`};
    const frame = (width: number, rows = 24) => {
      const lines = panel!({terminal: {rows}}, theme).render(width);
      for (const line of lines) assert.equal(visibleWidth(line), width);
      return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
    };
    const spawn = async (task: string, preset = 'reader'): Promise<string> => (await execute('subagent', {task, preset})).details.id;
    const writer = await spawn('hold', 'writer');
    const queuedWriter = await spawn('hold', 'writer');
    const readers = [await spawn(`${'x'.repeat(99)}😀 cut inside the emoji`)];
    for (let i = 1; i < 18; i++) readers.push(await spawn(`${i} ${'界'.repeat(50)} 🧪`));
    const ids = (lines: string[]) => lines.map(line => line.slice(2, 10));
    let lines = frame(80);
    assert.equal(lines.length, 12, 'header, eight rows and a summary between the borders');
    assert.match(lines[0], /^╭─+╮$/);
    assert.match(lines[1], /^│ Subagents · 20 active +│$/);
    assert.deepEqual(ids(lines.slice(2, 10)), [writer, ...readers.slice(0, 7)].map(id => id.slice(0, 8)));
    assert.ok(lines.slice(2, 10).every(line => line.includes(' · running · ')));
    assert.match(lines[10], /^│ … 12 more · 12 queued +│$/);
    assert.match(lines[11], /^╰─+╯$/);
    assert.ok(!lines.join('\n').includes(queuedWriter.slice(0, 8)), 'a queued child never displaces a running one');
    assert.match(frame(200)[3], /x{99}\uFFFD +│$/, 'a brief cut inside an emoji is measured as the terminal shows it');
    lines = frame(80, 16);
    assert.equal(lines.length, 8, 'half of a 16-row terminal');
    assert.match(lines[6], /^│ … 16 more · 4 running · 12 queued +│$/);
    lines = frame(80, 4);
    assert.equal(lines.length, 5, 'one row and a summary on a tiny terminal');
    assert.deepEqual(ids(lines.slice(2, 3)), [writer.slice(0, 8)]);
    assert.match(lines[3], /^│ … 19 more · 7 running · 12 queued +│$/);
    for (const width of [6, 20]) {
      const narrow = frame(width);
      assert.equal(narrow.length, 12);
      assert.ok(narrow.slice(1, -1).every(line => line.startsWith('│ ') && line.endsWith(' │')));
    }
    assert.deepEqual(panel!({terminal: {rows: 24}}, theme).render(5), []);

    await execute('subagent_cancel', {id: queuedWriter});
    assert.match(frame(80)[10], /^│ … 11 more · 11 queued +│$/, 'hidden children still repaint the summary');
    for (const id of readers.slice(8)) await execute('subagent_cancel', {id});
    lines = frame(80);
    assert.equal(lines.length, 12, 'nine children fit without a summary');
    assert.match(lines[1], /^│ Subagents · 9 active +│$/);
    assert.deepEqual(ids(lines.slice(2, 11)), [writer, ...readers.slice(0, 8)].map(id => id.slice(0, 8)));
    assert.match(lines[10], / · queued · 7 界/);
    await execute('subagent_cancel', {id: readers[7]});
    assert.equal(frame(80).length, 11);
    await execute('subagent_cancel', {id: 'all'});
    assert.equal(panel, undefined);
  }));
