import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, type Plan } from './policy.ts';

const url = 'https://claude.ai/artifact/1Tnqd5SZSshD1VHdpDgJW8';
const staged = '/home/ar/.pi/agent/claude-artifacts/helper/job-1/page.html';
const publish: Plan = { steps: [{ input: { action: 'publish', file_path: 'job-1/page.html' }, allowIcon: true }], readableFile: staged };
const update: Plan = { steps: [{ input: { action: 'read', url } }, { input: { action: 'publish', file_path: 'job-1/page.html', url } }], readableFile: staged };
const artifact = (input: Record<string, unknown>, id = 'toolu_1') => ({ tool: 'Artifact', input, id });

test('only the planned Artifact call is allowed, and its tool-use id is reserved for the result', () => {
  const policy = createPolicy(update);
  assert.deepEqual(policy.decide(artifact({ action: 'read', url }, 'toolu_read')), { allow: true });
  assert.equal(policy.succeeded('toolu_read'), 0);
  assert.deepEqual(policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish')), { allow: true });
  assert.equal(policy.succeeded('toolu_publish'), 1);
  assert.equal(policy.succeeded('toolu_unknown'), undefined);
});

test('calls out of order, with extra fields or after the plan is done are denied with the exact expected input', () => {
  const policy = createPolicy(update);
  const early = policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }));
  assert.equal(early.allow, false);
  assert.match(!early.allow ? early.reason : '', /exactly \{"action":"read","url":"https:\/\/claude\.ai\/artifact\/1Tnqd5SZSshD1VHdpDgJW8"\}/);
  assert.deepEqual(policy.decide(artifact({ action: 'read', url, path: 'index.html' })).allow, false);
  assert.equal(createPolicy(update).decide(artifact({ action: 'read', url, constructor: 'x' })).allow, false);
  const done = createPolicy(publish); done.decide(artifact({ action: 'publish', file_path: 'job-1/page.html' }));
  assert.match(String((done.decide(artifact({ action: 'publish', file_path: 'job-1/page.html' }, 'toolu_2')) as { reason: string }).reason), /complete/);
});

test('a new publish may name its icon, but force and an update icon are never allowed', () => {
  assert.equal(createPolicy(publish).decide(artifact({ action: 'publish', file_path: 'job-1/page.html', icon: 'chart' })).allow, true);
  assert.equal(createPolicy(publish).decide(artifact({ action: 'publish', file_path: 'job-1/page.html', icon: 'Acme Corp™ logo' })).allow, false);
  assert.equal(createPolicy(publish).decide(artifact({ action: 'publish', file_path: 'job-1/page.html', force: true })).allow, false);
  const policy = createPolicy(update); policy.decide(artifact({ action: 'read', url }, 'toolu_read')); policy.succeeded('toolu_read');
  assert.equal(policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url, icon: 'chart' })).allow, false);
});

test('Read is allowed only for the staged file and does not use up a step', () => {
  const policy = createPolicy(publish);
  assert.equal(policy.decide({ tool: 'Read', input: { file_path: staged }, id: 'toolu_read' }).allow, true);
  assert.equal(policy.decide({ tool: 'Read', input: { file_path: '/home/ar/.ssh/id_ed25519' }, id: 'toolu_ssh' }).allow, false);
  assert.equal(policy.decide({ tool: 'Bash', input: { command: 'ls' }, id: 'toolu_bash' }).allow, false);
  assert.equal(policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html' })).allow, true);
});

test('the next call waits until the previous call has a result', () => {
  const policy = createPolicy(update);
  policy.decide(artifact({ action: 'read', url }, 'toolu_read'));
  const early = policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish'));
  assert.equal(early.allow, false);
  assert.match(!early.allow ? early.reason : '', /result/);
  assert.equal(policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish_again')).allow, false);
  const third = policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish_third'));
  assert.deepEqual(third.allow ? undefined : third.fatal, true);
  const waited = createPolicy(update);
  waited.decide(artifact({ action: 'read', url }, 'toolu_read')); waited.succeeded('toolu_read');
  assert.equal(waited.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_publish')).allow, true);
});

test('a reused tool-use id is denied, and the third denial ends the job', () => {
  const policy = createPolicy(update);
  assert.equal(policy.decide(artifact({ action: 'read', url }, 'toolu_a')).allow, true);
  policy.succeeded('toolu_a');
  assert.deepEqual(policy.decide(artifact({ action: 'publish', file_path: 'job-1/page.html', url }, 'toolu_a')), { allow: false, reason: `Call the Artifact tool with exactly ${JSON.stringify({ action: 'publish', file_path: 'job-1/page.html', url })}.`, fatal: false });
  assert.equal(policy.decide(artifact({ action: 'list' }, 'toolu_b')).allow, false);
  const third = policy.decide(artifact({ action: 'delete', url }, 'toolu_c'));
  assert.deepEqual(third.allow ? undefined : third.fatal, true);
});

test('an allowed publish without a success or a refusal leaves the outcome unknown', () => {
  const refusal = 'Publish refused — nothing was merged or published: a newer version (v2) is live.';
  const publishing = (plan: Plan) => {
    const policy = createPolicy(plan);
    if (plan === update) { policy.decide(artifact({ action: 'read', url }, 'toolu_read')); policy.succeeded('toolu_read'); }
    policy.decide(artifact(plan.steps.at(-1)!.input, 'toolu_publish'));
    return policy;
  };
  assert.equal(createPolicy(publish).publishOutcomeUnknown(), false);
  for (const plan of [publish, update]) {
    assert.equal(publishing(plan).publishOutcomeUnknown(), true);
    const done = publishing(plan); assert.equal(done.succeeded('toolu_publish'), plan.steps.length - 1); assert.equal(done.publishOutcomeUnknown(), false);
    const refused = publishing(plan); assert.equal(refused.failed('toolu_publish', refusal)?.refused, true); assert.equal(refused.publishOutcomeUnknown(), false);
    const broken = publishing(plan); assert.equal(broken.failed('toolu_publish', 'socket hang up')?.refused, false); assert.equal(broken.publishOutcomeUnknown(), true);
  }
  const read = createPolicy(update); read.decide(artifact({ action: 'read', url }, 'toolu_read'));
  assert.equal(read.failed('toolu_read', 'socket hang up')?.step, 0); assert.equal(read.publishOutcomeUnknown(), false);
  const stale = publishing(update); assert.equal(stale.succeeded('toolu_read'), 0); stale.failed('toolu_read', refusal); assert.equal(stale.publishOutcomeUnknown(), true);
  assert.equal(publishing(publish).failed('toolu_other', { toString: null }), undefined);
});
