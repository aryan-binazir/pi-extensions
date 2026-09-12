import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ServerConfig, validateConfig, mergeConfig, resolveEnvironment, resolveHeaders, requestTimeout, startupTimeout } from './config.ts';
const validate = (server: unknown) => validateConfig({ servers: { test: server } }).servers.test;
const aliases = {
  startup_timeout_sec: ['startupTimeoutMs', 1.25, 1250], tool_timeout_sec: ['toolTimeoutMs', 0.01, 10],
  enabled_tools: ['allowTools', ['a'], ['a']], disabled_tools: ['denyTools', ['b'], ['b']],
  env_vars: ['envVars', ['HOME'], ['HOME']], http_headers: ['headers', { X: 'v' }, { X: 'v' }],
  env_http_headers: ['envHeaders', { X: 'HOME' }, { X: 'HOME' }], bearer_token_env_var: ['bearerTokenEnvVar', 'HOME', 'HOME'],
} as const;
test('all aliases normalize and conflict even when equal', () => {
  for (const [alias, [canonical, value, expected]] of Object.entries(aliases)) {
    const base = ['headers', 'envHeaders', 'bearerTokenEnvVar'].includes(canonical) ? { url: 'https://example.com' } : { command: 'run' };
    const result = validateConfig({ mcp_servers: { a: { ...base, [alias]: value } } }).servers.a;
    assert.deepEqual((result as any)[canonical], expected);
    assert.equal(Object.hasOwn(result, alias), false);
    assert.throws(() => validate({ ...base, [alias]: value, [canonical]: expected }), /Conflicting/);
  }
});
test('strict roots, records, unsupported policies and OAuth shapes', () => {
  for (const root of [null, [], {}, { servers: {}, mcp_servers: {} }, { servers: {}, extra: 1 }, { servers: [] }, Object.create({ servers: {} })]) assert.throws(() => validateConfig(root));
  for (const server of [null, [], new Date(), Object.create({ command: 'run' }), { command: 'run', required: false }, { command: 'run', auth: 'oauth' }, { command: 'run', unknown: 'secret' }]) assert.throws(() => validate(server));
  for (const oauth of [null, [], false, 'yes', { client_id: 'x' }, { clientId: 2 }, { scope: false }]) assert.throws(() => validate({ url: 'https://example.com', oauth }));
  assert.deepEqual(validate({ url: 'https://example.com', oauth: {} }).oauth, {});
  assert.throws(() => validate({ url: 'https://example.com', oauth: {}, bearerTokenEnvVar: 'TOKEN' }), /Ambiguous/);
});
test('deep clone and prototype safety without invoking accessors', () => {
  const input = { command: 'run', args: ['a'], env: { A: 'b' }, allowTools: ['x'] };
  const result = validate(input);
  result.args!.push('b'); result.env!.A = 'c'; result.allowTools!.push('y');
  assert.deepEqual(input, { command: 'run', args: ['a'], env: { A: 'b' }, allowTools: ['x'] });
  const root = JSON.parse('{"servers":{"__proto__":{"command":"run"},"constructor":{"command":"run"}}}');
  assert.equal(Object.hasOwn(validateConfig(root).servers, '__proto__'), true);
  assert.equal(({} as any).command, undefined);
  assert.throws(() => validate(JSON.parse('{"command":"run","__proto__":{}}')));
  assert.throws(() => validate({ get command() { throw new Error('SECRET'); } }), error => !String(error).includes('SECRET'));
  const nullRecord = Object.assign(Object.create(null), { command: 'run' });
  assert.equal(validate(nullRecord).command, 'run');
});
test('transport and URL restrictions also apply to disabled servers', () => {
  for (const server of [{}, { command: 'run', url: 'https://example.com' }, { command: '' }, { command: 'run', cwd: ' ' }, { command: 'run', transport: 'http' }, { url: 'https://example.com', transport: 'stdio' }]) assert.throws(() => validate({ ...server, enabled: false }));
  for (const field of ['args', 'env', 'envVars', 'cwd']) assert.throws(() => validate({ url: 'https://example.com', [field]: field === 'cwd' ? '.' : field === 'env' ? {} : [] }));
  for (const field of ['headers', 'envHeaders', 'bearerTokenEnvVar', 'oauth']) assert.throws(() => validate({ command: 'run', [field]: field === 'bearerTokenEnvVar' ? 'TOKEN' : {} }));
  for (const url of ['', 'secret-not-a-url', 'http://example.com', 'ftp://localhost', 'https://user:secret@example.com', 'https://example.com/#', 'https://example.com/#secret']) assert.throws(() => validate({ url }), error => !String(error).includes('secret'));
  for (const url of ['https://example.com', 'http://localhost', 'http://127.0.0.1:8000', 'http://[::1]']) assert.equal(validate({ url }).url, url);
});
test('scalar, list, identifier and numeric bounds', () => {
  for (const field of ['timeoutMs', 'startupTimeoutMs', 'toolTimeoutMs', 'maxOutputBytes']) {
    const min = field === 'maxOutputBytes' ? 256 : 10, max = field === 'maxOutputBytes' ? 1048576 : 120000;
    for (const value of [min, max]) validate({ command: 'run', [field]: value });
    for (const value of [min - 1, max + 1, NaN, Infinity, 10.1, '100', null]) assert.throws(() => validate({ command: 'run', [field]: value }));
  }
  assert.equal(validate({ command: 'run', startup_timeout_sec: 1.001 }).startupTimeoutMs, 1001);
  for (const value of [0.0101, Infinity, '1', null]) assert.throws(() => validate({ command: 'run', startup_timeout_sec: value }));
  for (const field of ['args', 'allowTools', 'denyTools', 'envVars']) {
    validate({ command: 'run', [field]: Array(256).fill('A') });
    for (const value of [Array(257).fill('A'), [1], [null], {}, Array(1)]) assert.throws(() => validate({ command: 'run', [field]: value }));
  }
  for (const name of ['', '1A', 'A-B', 'A B', 'A.B']) {
    assert.throws(() => validate({ command: 'run', env: { [name]: 'secret' } }));
    assert.throws(() => validate({ command: 'run', envVars: [name] }));
    assert.throws(() => validate({ url: 'https://example.com', envHeaders: { X: name } }));
    assert.throws(() => validate({ url: 'https://example.com', bearerTokenEnvVar: name }));
  }
  assert.throws(() => validate({ command: 'run', env_vars: [{ name: 'TOKEN', source: 'remote' }] }));
  for (const value of [null, [], false, { A: 1 }]) assert.throws(() => validate({ command: 'run', env: value }));
  for (const value of [0, 'false', null]) assert.throws(() => validate({ command: 'run', enabled: value }));
});
test('merge replaces entire entries, ignores untrusted project, bounds combined map', () => {
  const global = { servers: { a: { command: 'old', args: ['old'] } } };
  const explicit = { servers: { a: { command: 'new' } } };
  assert.deepEqual(mergeConfig(global, null as any, explicit, false), explicit);
  assert.throws(() => mergeConfig(global, null as any, explicit, true));
  const servers = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [String(i), { command: 'run' }]));
  validateConfig({ servers });
  assert.throws(() => mergeConfig({ servers }, { servers: {} }, explicit, false), /32/);
  assert.deepEqual(mergeConfig(global, explicit, { servers: {} }, true), explicit);
});
test('runtime environment is minimal, fresh, fail closed and overrides inherited values', () => {
  const names = ['MCP_CONFIG_TEST_A', 'MCP_CONFIG_TEST_B', 'MCP_CONFIG_TEST_MISSING'];
  const old = names.map(name => process.env[name]);
  try {
    process.env[names[0]] = 'secret-one'; process.env[names[1]] = 'secret-two'; delete process.env[names[2]];
    assert.deepEqual(resolveEnvironment({}), getDefaultEnvironment());
    const config = { envVars: [names[0]], env: { [names[0]]: '${MCP_CONFIG_TEST_B}', C: '${MCP_CONFIG_TEST_A}' } };
    assert.equal(resolveEnvironment(config)[names[0]], 'secret-two');
    process.env[names[1]] = 'changed';
    assert.equal(resolveEnvironment(config)[names[0]], 'changed');
    assert.throws(() => resolveEnvironment({ envVars: [names[2]], env: { [names[2]]: 'override' } }), /unavailable/);
    assert.throws(() => resolveEnvironment({ env: { A: '${MCP_CONFIG_TEST_MISSING}' } }), /unavailable/);
    const headers = resolveHeaders({ headers: { X: '${MCP_CONFIG_TEST_A}', Authorization: 'static' }, envHeaders: { x: names[1], authorization: names[0] }, bearerTokenEnvVar: names[1] });
    assert.equal(headers.get('x'), 'changed'); assert.equal(headers.get('authorization'), 'Bearer changed');
    assert.equal(resolveHeaders({ headers: { X: 'static' }, envHeaders: { X: names[0] } }).get('x'), 'secret-one');
    for (const config of [{ headers: { 'secret-invalid header': 'secret-value' } }, { headers: { X: 'secret\nvalue' } }, { envHeaders: { X: names[2] } }, { bearerTokenEnvVar: names[2] }] as ServerConfig[]) assert.throws(() => resolveHeaders(config), error => !String(error).includes('secret'));
    assert.throws(() => resolveHeaders({ bearerTokenEnvVar: names[0], oauth: {} }), /Ambiguous/);
  } finally { names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }); }
});
test('timeout precedence', () => {
  assert.equal(requestTimeout({}), 60000); assert.equal(startupTimeout({}), 10000);
  assert.equal(requestTimeout({ timeoutMs: 100 }), 100); assert.equal(startupTimeout({ timeoutMs: 100 }), 100);
  assert.equal(requestTimeout({ timeoutMs: 100, toolTimeoutMs: 200 }), 200);
  assert.equal(startupTimeout({ timeoutMs: 100, startupTimeoutMs: 300 }), 300);
});
