import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piInvocation } from './registry.ts';

test('inherited guard is last after caller hooks even when explicitly listed by the caller', () => {
  const invocation = piInvocation({ task: 'fixture', cwd: '/tmp', tools: ['read'], timeout: 1000,
    extensions: ['/guard.ts', '/caller.ts'] }, { extensions: ['/guard.ts'], env: { PI_SENTINEL_PARENT: '/private/parent.json' } });
  const loaded = invocation.args.filter((_arg, index) => invocation.args[index - 1] === '-e');
  assert.deepEqual(loaded, ['/caller.ts', '/guard.ts']);
  assert.equal(invocation.env.PI_SENTINEL_PARENT, '/private/parent.json');
});
