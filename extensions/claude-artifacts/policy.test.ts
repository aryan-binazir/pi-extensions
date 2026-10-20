import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, policyState, resolveStep, type Plan } from './policy.ts';

const url = 'https://claude.ai/artifact/1Tnqd5SZSshD1VHdpDgJW8';
const staged = '/home/ar/.pi/agent/claude-artifacts/helper/job-1/page.html';
const publish: Plan = { steps: [{ input: { action: 'publish', file_path: 'job-1/page.html' }, icon: true }], readable: staged };
const update: Plan = { steps: [{ input: { action: 'read', url } }, { input: { action: 'publish', file_path: 'job-1/page.html', url } }], readable: staged };
const artifact = (input: Record<string, unknown>, id = 'toolu_1') => ({ tool: 'Artifact', input, id });

test('only the planned Artifact call is allowed, and its tool-use id is reserved for the result', () => {
  const state = policyState();
  assert.deepEqual(decide(update, state, artifact({ action: 'read', url }, 'toolu_read')), { allow: true, step: 0 });
  assert.equal(state.reserved.get('toolu_read'), 0);
  resolveStep(state, 'toolu_read');
  assert.deepEqual(decide(update, state, artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish')), { allow: true, step: 1 });
});

test('calls out of order, with extra fields or after the plan is done are denied with the exact expected input', () => {
  const state = policyState();
  const early = decide(update, state, artifact({ action: 'publish', file_path: 'job-1/page.html', url }));
  assert.equal(early.allow, false);
  assert.match(!early.allow ? early.reason : '', /exactly \{"action":"read","url":"https:\/\/claude\.ai\/artifact\/1Tnqd5SZSshD1VHdpDgJW8"\}/);
  assert.deepEqual(decide(update, state, artifact({ action: 'read', url, path: 'index.html' })).allow, false);
  assert.equal(decide(update, policyState(), artifact({ action: 'read', url, constructor: 'x' })).allow, false);
  const done = policyState(); decide(publish, done, artifact({ action: 'publish', file_path: 'job-1/page.html' }));
  assert.match(String((decide(publish, done, artifact({ action: 'publish', file_path: 'job-1/page.html' }, 'toolu_2')) as { reason: string }).reason), /complete/);
});

test('a new publish may name its icon, but force and an update icon are never allowed', () => {
  assert.equal(decide(publish, policyState(), artifact({ action: 'publish', file_path: 'job-1/page.html', icon: 'chart' })).allow, true);
  assert.equal(decide(publish, policyState(), artifact({ action: 'publish', file_path: 'job-1/page.html', icon: 'Acme Corp™ logo' })).allow, false);
  assert.equal(decide(publish, policyState(), artifact({ action: 'publish', file_path: 'job-1/page.html', force: true })).allow, false);
  const state = policyState(); decide(update, state, artifact({ action: 'read', url }, 'toolu_read')); resolveStep(state, 'toolu_read');
  assert.equal(decide(update, state, artifact({ action: 'publish', file_path: 'job-1/page.html', url, icon: 'chart' })).allow, false);
});

test('Read is allowed only for the staged file and does not use up a step', () => {
  const state = policyState();
  assert.equal(decide(publish, state, { tool: 'Read', input: { file_path: staged }, id: 'toolu_read' }).allow, true);
  assert.equal(decide(publish, state, { tool: 'Read', input: { file_path: '/home/ar/.ssh/id_ed25519' }, id: 'toolu_ssh' }).allow, false);
  assert.equal(decide(publish, state, { tool: 'Bash', input: { command: 'ls' }, id: 'toolu_bash' }).allow, false);
  assert.equal(decide(publish, state, artifact({ action: 'publish', file_path: 'job-1/page.html' })).allow, true);
});

test('the next call waits until the previous call has a result', () => {
  const state = policyState();
  decide(update, state, artifact({ action: 'read', url }, 'toolu_read'));
  const early = decide(update, state, artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish'));
  assert.equal(early.allow, false);
  assert.match(!early.allow ? early.reason : '', /result/);
  resolveStep(state, 'toolu_read');
  assert.equal(decide(update, state, artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish')).allow, true);
});

test('a reused tool-use id is denied, and the third denial ends the job', () => {
  const state = policyState();
  assert.equal(decide(update, state, artifact({ action: 'read', url }, 'toolu_a')).allow, true);
  resolveStep(state, 'toolu_a');
  assert.deepEqual(decide(update, state, artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_a')), { allow: false, reason: `Call the Artifact tool with exactly ${JSON.stringify({ action: 'publish', file_path: 'job-1/page.html', url })}.`, fatal: false });
  assert.equal(decide(update, state, artifact({ action: 'list' }, 'toolu_b')).allow, false);
  const third = decide(update, state, artifact({ action: 'delete', url }, 'toolu_c'));
  assert.deepEqual(third.allow ? undefined : third.fatal, true);
});
