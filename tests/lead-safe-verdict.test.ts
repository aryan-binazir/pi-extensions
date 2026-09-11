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
