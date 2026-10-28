import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createCodemodeExtension, createMcpExtension, type ExtensionAPI, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { withPi } from '../../tests/pi-session.ts';
import guardian, { registerFailClosed } from './index.ts';
import { APPROVAL_AUDIT_ENTRY_TYPE } from './approvals.ts';
import { until } from '../subagents/test-support.ts';

const mutation = 'mcp__guardian_fixture__update';
const secret = 'synthetic-sensitive-connector-token';

test('Guardian rejects a connector leaf before it executes and reviews the exact arguments once', async () => {
  const reviews: string[] = [], notices: string[] = [];
  let effects = '';
  let api!: ExtensionAPI;
  const connector: ExtensionFactory = pi => {
    api = pi;
    pi.on('session_start', (_event, ctx) => {
      effects = join(ctx.cwd, 'connector-effects.jsonl');
      pi.registerMcpServer('guardian_fixture', { command: process.execPath,
        args: [new URL('../../tests/fixtures/guardian-connector.mjs', import.meta.url).pathname, effects], exposure: 'direct' });
    });
  };
  await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [guardian, connector, { name: 'mcp', builtin: true, factory: createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }) }], responses: [
    fauxAssistantMessage(fauxToolCall(mutation, { token: secret, value: 3 })),
    context => {
      reviews.push(JSON.stringify(context));
      return fauxAssistantMessage(JSON.stringify({ outcome: 'deny', rationale: `Not authorized: ${secret}` }));
    },
    fauxAssistantMessage('Stopped.'),
  ], bind: () => ({ uiContext: { notify: (message: string) => { notices.push(message); }, setStatus() {} } as any }), configure: ({ agentDir }, provider) => {
    mkdirSync(join(agentDir, 'guardian'), { recursive: true });
    writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({
      reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' },
    }));
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await until(() => api.getAllTools().some(t => t.name === mutation), 'synthetic MCP registration', 5000);
    await session.prompt('Consider this synthetic update.');
    assert.equal(existsSync(effects), false);
    const results = session.messages.filter(message => message.role === 'toolResult');
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, true);
    assert.match(JSON.stringify(results[0]), /Not authorized/);
    const audit = session.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE);
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(secret), 'Guardian audits never store connector arguments or reviewer echoes');
    await session.prompt('/guardian audit');
    assert.ok(!notices.at(-1)?.includes(secret));
    await session.prompt('/guardian approve');
    assert.ok(!session.messages.some(message => message.role === 'custom' && message.customType === 'guardian-manual-approval'));
  });
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].includes(secret));
  assert.match(reviews[0], /value/);
});

const cases = [
  { label: 'unknown MCP mutation', review: true },
  { label: 'approved connector error is preserved', review: true, resultError: true },
  { label: 'read-only MCP hint', annotations: { readOnlyHint: true }, review: false },
  { label: 'contradictory hints', annotations: { readOnlyHint: true, destructiveHint: true }, review: true },
  { label: 'exact read-only override', connectors: { readOnly: ['fixture_update'] }, review: false },
  { label: 'force wins over hint and override', annotations: { readOnlyHint: true }, connectors: { readOnly: ['fixture_update'], alwaysReview: ['fixture_update'] }, review: true },
  { label: 'ordinary namespaced extension', custom: true, review: false },
  { label: 'declared custom connector', custom: true, connectors: { alwaysReview: ['fixture_update'] }, review: true },
  { label: 'unrelated built-in', builtin: 'codemode', connectors: { alwaysReview: ['fixture_update'] }, review: false },
  { label: 'disabled Guardian', config: { enabled: false }, review: false },
  { label: 'runtime Guardian off', toggleOff: true, review: false },
  { label: 'failed model falls back to a human', config: { reviewer: { provider: 'missing', model: 'missing' } }, human: true, review: false },
  { label: 'never approves mutations', config: { approvalPolicy: 'never' }, review: false, blocked: true },
  { label: 'human reviewer without UI', config: { approvalsReviewer: 'user' }, review: false, blocked: true },
  { label: 'missing reviewer fails closed', config: { reviewer: { provider: 'missing', model: 'missing' } }, review: false, blocked: true },
];

for (const scenario of cases) test(`connector gate: ${scenario.label}`, async () => {
  let effects = 0, reviews = 0, humanPrompts = 0;
  const name = 'fixture_update';
  const fixture: ExtensionFactory = pi => pi.registerTool({ name, label: name, description: 'Synthetic connector',
    namespace: { name: 'mcp__fixture' }, annotations: scenario.annotations,
    parameters: Type.Object({ value: Type.Number() }),
    async execute(_id, args) { effects++; return { content: [{ type: 'text', text: JSON.stringify(args) }], details: {}, ...(scenario.resultError ? { isError: true } : {}) }; },
  });
  const builtin = scenario.builtin ?? 'mcp';
  await withPi({ settings: scenario.custom ? {} : { extensions: [`builtin:${builtin}`] },
    extensions: [guardian, scenario.custom ? fixture : { name: builtin, builtin: true, factory: fixture }],
    responses: [fauxAssistantMessage(fauxToolCall(name, { value: 7 })),
      ...(scenario.review ? [() => { reviews++; return fauxAssistantMessage('{"outcome":"allow"}'); }] : []),
      fauxAssistantMessage('Done.')],
    bind: scenario.human ? () => ({ uiContext: { select: async (title: string, choices: string[]) => { humanPrompts++; assert.match(title, /\"value\": 7/); return choices[0]; }, notify() {}, setStatus() {} } as any }) : undefined,
    configure: ({ agentDir }, provider) => {
      mkdirSync(join(agentDir, 'guardian'), { recursive: true });
      writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({
        reviewer: { provider: provider.getModel().provider, model: provider.getModel().id },
        ...(scenario.connectors ? { connectors: scenario.connectors } : {}), ...scenario.config,
      }));
      return { model: provider.getModel() };
    },
  }, async ({ session }) => {
    if (scenario.toggleOff) await session.prompt('/guardian off');
    await session.prompt('Run the synthetic fixture.');
    assert.equal(effects, scenario.blocked ? 0 : 1);
    assert.equal(session.messages.filter(m => m.role === 'toolResult').at(-1)?.isError ?? false, Boolean(scenario.blocked || scenario.resultError));
  });
  assert.equal(reviews, scenario.review ? 1 : 0);
  assert.equal(humanPrompts, scenario.human ? 1 : 0);
});

test('real codemode reviews each mutation once, preserves arguments, and keeps prior effects after a later denial', async () => {
  let api!: ExtensionAPI, effects = '', reviews = 0;
  const connector: ExtensionFactory = pi => {
    api = pi;
    pi.on('session_start', (_event, ctx) => {
      effects = join(ctx.cwd, 'connector-effects.jsonl');
      pi.registerMcpServer('guardian_fixture', { command: process.execPath,
        args: [new URL('../../tests/fixtures/guardian-connector.mjs', import.meta.url).pathname, effects], exposure: 'codemode' });
    });
  };
  await withPi({ settings: { extensions: ['builtin:mcp', 'builtin:codemode'], defaultTools: ['codemode'] }, extensions: [guardian, connector,
    { name: 'mcp', builtin: true, factory: createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }) },
    { name: 'codemode', builtin: true, factory: createCodemodeExtension() }],
    responses: [fauxAssistantMessage(fauxToolCall('codemode', { code: `for (const value of [1, 2, 3]) text(await tools.${mutation}({ value, token: ${JSON.stringify(secret)} }));` })),
      ...[1, 2, 3].map(value => () => { reviews++; return fauxAssistantMessage(JSON.stringify({ outcome: value === 3 ? 'deny' : 'allow', rationale: 'Synthetic batch decision' })); }),
      fauxAssistantMessage('Done.')],
    configure: ({ agentDir }, provider) => {
      mkdirSync(join(agentDir, 'guardian'), { recursive: true });
      writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({ reviewer: { provider: provider.getModel().provider, model: provider.getModel().id } }));
      return { model: provider.getModel() };
    },
  }, async ({ session }) => {
    await until(() => api.getAllTools().some(t => t.name === mutation), 'synthetic MCP registration', 5000);
    await session.prompt('Run this synthetic batch.');
    const calls = readFileSync(effects, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.arguments), [{ value: 1, token: secret }, { value: 2, token: secret }]);
    assert.equal(reviews, 3);
    assert.match(JSON.stringify(session.messages.filter(m => m.role === 'toolResult')), /Synthetic batch decision/);
  });
});

test('Guardian startup failure blocks MCP mutations before any effect', async () => {
  let effects = 0;
  await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [pi => registerFailClosed(pi, new Error('synthetic startup failure')),
    { name: 'mcp', builtin: true, factory: pi => pi.registerTool({ name: mutation, label: mutation, description: 'Synthetic mutation',
      parameters: Type.Object({}),
      async execute() { effects++; return { content: [{ type: 'text', text: 'executed' }], details: {} }; },
    }) }], responses: [fauxAssistantMessage(fauxToolCall(mutation, {})), fauxAssistantMessage('Stopped.')],
  }, async ({ session }) => {
    await session.prompt('Try the synthetic mutation.');
    assert.equal(effects, 0);
    assert.match(JSON.stringify(session.messages.filter(m => m.role === 'toolResult')), /synthetic startup failure/);
  });
});

test('cancelling a nested connector during review never executes it even when the reviewer allows', async () => {
  let effects = 0, reviews = 0;
  const cancelled = new AbortController();
  const container: ExtensionFactory = pi => pi.registerTool({ name: 'fixture_delegate', label: 'delegate', description: 'Synthetic delegator', parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const result = await ctx.executeTool(mutation, {}, { signal: cancelled.signal });
      return { ...result.result, isError: result.isError, details: {} };
    },
  });
  await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [guardian, container,
    { name: 'mcp', builtin: true, factory: pi => pi.registerTool({ name: mutation, label: mutation, description: 'Synthetic mutation', parameters: Type.Object({}),
      async execute() { effects++; return { content: [{ type: 'text', text: 'executed' }], details: {} }; },
    }) }], responses: [fauxAssistantMessage(fauxToolCall('fixture_delegate', {})), () => { reviews++; cancelled.abort(); return fauxAssistantMessage('{"outcome":"allow"}'); }, fauxAssistantMessage('Stopped.')],
    configure: ({ agentDir }, provider) => {
      mkdirSync(join(agentDir, 'guardian'), { recursive: true });
      writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({ reviewer: { provider: provider.getModel().provider, model: provider.getModel().id } }));
      return { model: provider.getModel() };
    },
  }, async ({ session }) => {
    await session.prompt('Try the synthetic delegated mutation.');
    assert.equal(effects, 0);
    assert.equal(reviews, 1);
    assert.match(JSON.stringify(session.messages.filter(m => m.role === 'toolResult')), /aborted/i);
  });
});

for (const failure of ['audit', 'oversize', 'metadata'] as const) test(`connector ${failure} failure blocks execution`, async () => {
  let effects = 0, reviews = 0;
  const fixture: ExtensionFactory = pi => pi.registerTool({ name: mutation, label: mutation, description: 'Synthetic mutation', parameters: Type.Object({ payload: Type.String() }),
    async execute() { effects++; return { content: [{ type: 'text', text: 'executed' }], details: {} }; },
  });
  await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [pi => guardian({ ...pi,
    getAllTools: failure === 'metadata' ? () => { throw new Error('synthetic metadata unavailable'); } : pi.getAllTools,
    appendEntry: (type, data) => { if (type === APPROVAL_AUDIT_ENTRY_TYPE) throw new Error('synthetic audit disk full'); pi.appendEntry(type, data); },
  }), { name: 'mcp', builtin: true, factory: fixture }],
    responses: [fauxAssistantMessage(fauxToolCall(mutation, { payload: failure === 'oversize' ? '界'.repeat(90_000) : secret })),
      ...(failure === 'audit' ? [() => { reviews++; return fauxAssistantMessage('{"outcome":"allow"}'); }] : []), fauxAssistantMessage('Stopped.')],
    configure: ({ agentDir }, provider) => {
      mkdirSync(join(agentDir, 'guardian'), { recursive: true });
      writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({ reviewer: { provider: provider.getModel().provider, model: provider.getModel().id } }));
      return { model: provider.getModel() };
    },
  }, async ({ session }) => {
    await session.prompt('Try the synthetic mutation.');
    assert.equal(effects, 0);
    assert.equal(reviews, failure === 'audit' ? 1 : 0);
    assert.match(JSON.stringify(session.messages.filter(m => m.role === 'toolResult')), failure === 'audit' ? /audit disk full/ : failure === 'metadata' ? /metadata unavailable/ : /too large to review completely/);
  });
});

test('parallel tool batches review serially before executing the approved subset', async () => {
  const effects: number[] = [];
  let reviews = 0;
  await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [guardian,
    { name: 'mcp', builtin: true, factory: pi => pi.registerTool({ name: mutation, label: mutation, description: 'Synthetic mutation',
      parameters: Type.Object({ value: Type.Number() }),
      async execute(_id, args) { effects.push(args.value); return { content: [{ type: 'text', text: 'executed' }], details: {} }; },
    }) }], responses: [fauxAssistantMessage([fauxToolCall(mutation, {value: 1}), fauxToolCall(mutation, {value: 2})]),
      ...['allow', 'deny'].map(outcome => () => { reviews++; assert.deepEqual(effects, []); return fauxAssistantMessage(JSON.stringify({outcome})); }), fauxAssistantMessage('Done.')],
    configure: ({ agentDir }, provider) => {
      mkdirSync(join(agentDir, 'guardian'), { recursive: true });
      writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify({ reviewer: { provider: provider.getModel().provider, model: provider.getModel().id } }));
      return { model: provider.getModel() };
    },
  }, async ({ session }) => {
    session.agent.toolExecution = 'parallel';
    await session.prompt('Try the synthetic batch.');
    assert.deepEqual(effects, [1]);
    assert.equal(reviews, 2);
    assert.deepEqual(session.messages.filter(m => m.role === 'toolResult').map(m => m.isError ?? false), [false, true]);
  });
});
