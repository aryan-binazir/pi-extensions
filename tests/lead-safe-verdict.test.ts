// Lead-owned acceptance from Ar's reference: safe executes, ask requests
// approval, unsafe blocks. See _scratch/implementer/lead-safe-classifier-finding.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoPolicy } from '../extensions/auto-mode/policy.ts';

test('reference acceptance: classifier-safe shell action runs without asking', async () => {
  const cwd = process.cwd();
  const action = {tool: 'bash', input: {command: 'git status --short'}, cwd};
  let classified = 0;
  const decision = await new AutoPolicy(cwd).check(action, {
    classify: async () => { classified++; return 'safe'; },
    approve: async () => { assert.fail('A safe verdict must not become an approval prompt'); },
  });
  assert.equal(classified, 1, 'Exercise classifier decision, not a new deterministic command whitelist');
  assert.equal(decision.allow, true);
  assert.equal(decision.classification, 'safe');
  assert.equal((await new AutoPolicy(cwd).check(action, {classify: async () => 'safe'})).allow, true);
});

test('reference acceptance: ask, unsafe and failed classifiers preserve their distinct behavior', async () => {
  const cwd = process.cwd();
  const action = {tool: 'bash', input: {command: 'git status --short'}, cwd};
  assert.equal((await new AutoPolicy(cwd).check(action, {classify: async () => 'ask'})).allow, false);
  assert.equal((await new AutoPolicy(cwd).check(action, {classify: async () => 'ask', approve: async () => true})).allow, true);
  assert.equal((await new AutoPolicy(cwd).check(action, {classify: async () => 'unsafe', approve: async () => true})).allow, false);
  assert.equal((await new AutoPolicy(cwd).check(action, {classify: async () => {throw Error('offline');}, approve: async () => true})).allow, false);
  assert.equal((await new AutoPolicy(cwd, ['read'], true).check(action, {classify: async () => 'safe', approve: async () => true})).allow, false);
});

test('reference acceptance: permitted custom tools honor classifier safe without trusting unknown tools', async () => {
  const cwd = process.cwd();
  const action = {tool: 'web_search', input: {query: 'Pi extension documentation'}, cwd};
  const permitted = new AutoPolicy(cwd, ['read', 'web_search']);
  assert.equal((await permitted.check(action, {classify: async () => 'safe'})).allow, true,
    'Known permitted integration tools must support safe -> execute too');
  assert.equal((await new AutoPolicy(cwd).check(action, {classify: async () => 'safe'})).allow, false,
    'An unknown tool is not implicitly permitted by its name or remote annotations');
});

test('reference acceptance: real auto-mode hook recognizes configured integration tools', async () => {
  const {default: autoMode} = await import('../extensions/auto-mode/index.ts');
  type API = import('@earendil-works/pi-coding-agent').ExtensionAPI;
  const handlers = new Map<string, (...args: any[]) => any>();
  const known = {name: 'web_search', description: 'Search public web results with a bounded result limit', parameters: {type: 'object', properties: {query: {type: 'string'}}}};
  autoMode({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    events: {on() {}, emit() {}}, registerCommand() {}, appendEntry() {},
    getAllTools: () => [known], getActiveTools: () => ['web_search'],
  } as unknown as API);
  let request = '';
  const ctx: any = {
    cwd: process.cwd(), hasUI: false, mode: 'print',
    sessionManager: {getSessionId: () => 'lead-configured-tool', getBranch: () => []},
    ui: {setStatus() {}}, model: {provider: 'synthetic'},
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ok: true}),
      getProvider: () => ({streamSimple: (_model: unknown, context: any) => {
        request = context.messages[0].content;
        return (async function* () {yield {type: 'text_delta', delta: 'safe'};})();
      }}),
    },
  };
  await handlers.get('session_start')!({}, ctx);
  try {
    const result = await handlers.get('tool_call')!({toolName: 'web_search', toolCallId: 'known', input: {query: 'Pi docs'}}, ctx);
    assert.equal(result, undefined, 'Configured integration tool with safe verdict must execute in actual hook');
    assert.match(request, /Search public web results/, 'Classifier receives real tool metadata to judge the operation');
    assert.equal((await handlers.get('tool_call')!({toolName: 'unregistered_remote_tool', toolCallId: 'unknown', input: {}}, ctx)).block, true);
  } finally {await handlers.get('session_shutdown')!({}, ctx);}
});
