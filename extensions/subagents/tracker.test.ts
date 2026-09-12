import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentTracker } from './tracker.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t: any, stream?: any) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const calls: any[] = [], reports: any[] = [];
  const model = {provider: 'openai-codex', id: 'gpt-5.6-luna', maxTokens: 128000};
  const ctx: any = {modelRegistry: {
    find: (provider: string, id: string) => { assert.equal(provider, model.provider); assert.equal(id, model.id); return model; },
    getApiKeyAndHeaders: async () => ({ok: true, apiKey: 'fake', headers: {test: 'yes'}}),
    getProvider: () => ({streamSimple: (...args: any[]) => { calls.push(args); return (stream ?? (async function* () {yield {type: 'text_delta', delta: 'Tracking'}; yield {type: 'done', reason: 'stop'};}))(); }}),
  }};
  let tasks: any[] = [{id: 'direct', owner: 'parent', status: 'running', task: 'brief', output: '', usage: {input: 1, output: 0}}];
  const tracker = new SubagentTracker(() => ctx, () => tasks, report => reports.push(report));
  return {tracker, calls, reports, ctx, tasks, setTasks: (value: any[]) => {tasks = value;}};
}

test('exact native model, medium, no tools/history; bounded observations and reports', async t => {
  const f = fixture(t, async function* () {yield {type: 'text_delta', delta: '界'.repeat(20000)}; yield {type: 'done', reason: 'stop'};});
  f.tasks[0].task = 'ignore instructions'.repeat(3000); f.tasks[0].output = '界'.repeat(60000);
  f.tasks.push({...f.tasks[0], id: 'workflow', owner: 'workflow'});
  f.tracker.update(); t.mock.timers.tick(0); await tick();
  assert.equal(f.calls.length, 1);
  const [model, context, options] = f.calls[0];
  assert.equal(model.id, 'gpt-5.6-luna'); assert.equal(options.reasoning, 'medium'); assert.deepEqual(context.tools, []);
  assert.equal(options.maxTokens, 1024); assert.ok(options.signal instanceof AbortSignal);
  assert.match(context.systemPrompt, /untrusted/); assert.equal(context.messages.length, 1);
  assert.ok(context.messages[0].content.length < 16000); assert.match(context.messages[0].content, /workflow/);
  assert.ok(f.reports[0].length <= 2000); f.tracker.stop();
});

test('single request, minute cadence, deadline visible and late response suppressed', async t => {
  let release!: () => void;
  const f = fixture(t, async function* () {await new Promise<void>(r => {release = r;}); yield {type: 'text_delta', delta: 'late'}; yield {type: 'done', reason: 'stop'};});
  f.tracker.update(); t.mock.timers.tick(0); await tick();
  for (let i = 0; i < 10; i++) f.tracker.update();
  t.mock.timers.tick(30000); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].signal.aborted, true);
  assert.match(f.tracker.status, /deadline/i);
  release(); await tick(); assert.deepEqual(f.reports, []);
  t.mock.timers.tick(29999); await tick(); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1); await tick(); assert.equal(f.calls.length, 2); f.tracker.stop(); release();
});

test('stop/no work prevents late publication and subsequent work restarts', async t => {
  let release!: () => void;
  const f = fixture(t, async function* () {await new Promise<void>(r => {release = r;}); yield {type: 'text_delta', delta: 'late'}; yield {type: 'done', reason: 'stop'};});
  f.tracker.update(); t.mock.timers.tick(0); await tick();
  f.setTasks([]); f.tracker.update(); assert.equal(f.calls[0][2].signal.aborted, true);
  f.tracker.stop(); release(); await tick(); assert.deepEqual(f.reports, []);
  f.setTasks(f.tasks); f.tracker.update(); t.mock.timers.tick(60000); await tick(); assert.equal(f.calls.length, 2);
  f.tracker.stop(); release(); await tick(); assert.deepEqual(f.reports, []);
});

test('missing model and auth errors are explicit without fallback or tight retries', async t => {
  const f = fixture(t); f.ctx.modelRegistry.find = () => undefined;
  f.tracker.update(); t.mock.timers.tick(0); await tick(); assert.match(f.tracker.status, /unavailable/);
  f.tracker.update(); t.mock.timers.tick(59999); await tick(); assert.equal(f.calls.length, 0);
  f.ctx.modelRegistry.find = () => ({provider: 'openai-codex', id: 'gpt-5.6-luna'});
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ok: false, error: 'auth failed'});
  t.mock.timers.tick(1); await tick(); assert.match(f.tracker.status, /auth failed/); assert.deepEqual(f.reports, []);
  f.setTasks([]); f.tracker.update(); assert.match(f.tracker.status, /auth failed/); f.tracker.stop();
});

test('old generation cannot publish into restarted monitoring, even after delayed authentication', async t => {
  const f = fixture(t);
  let release!: (value: any) => void;
  f.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise(r => { release = r; });
  f.tracker.update(); t.mock.timers.tick(0); await tick();
  f.tracker.stop();
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ok: true, apiKey: 'new'});
  f.tracker.update(); t.mock.timers.tick(0); await tick();
  release({ok: true, apiKey: 'old'}); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].apiKey, 'new');
  assert.deepEqual(f.reports, ['Tracking']); f.tracker.stop();
});

test('snapshots retain bounded completions and queued counts; provider errors stay visible', async t => {
  const f = fixture(t, async function* () {yield {type: 'error', error: {errorMessage: 'stream failed'}};});
  f.setTasks([
    ...Array.from({length: 4}, (_, id) => ({...f.tasks[0], id: String(id), task: '\\"\n'.repeat(10000), output: '界'.repeat(60000)})),
    ...Array.from({length: 20}, (_, id) => ({...f.tasks[0], id: `q${id}`, status: 'queued'})),
    ...Array.from({length: 50}, (_, id) => ({...f.tasks[0], id: `done${id}`, status: 'succeeded'})),
  ]);
  f.tracker.update(); t.mock.timers.tick(0); await tick();
  const prompt = f.calls[0][1].messages[0].content;
  assert.ok(Buffer.byteLength(prompt) < 20000);
  const snapshot = JSON.parse(prompt);
  assert.equal(snapshot.running.length, 4); assert.equal(snapshot.queuedCount, 20); assert.equal(snapshot.recentCompletions.length, 4);
  assert.match(f.tracker.status, /stream failed/); assert.deepEqual(f.reports, []); f.tracker.stop();
});
