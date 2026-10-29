// Ported from openai/codex codex-rs/prompts/src/guardian_instructions_tests.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GUARDIAN_POLICY, GUARDIAN_POLICY_TEMPLATE, guardianPolicyInstructions, REJECTION_INSTRUCTIONS, renderGuardianRejection,
  TIMEOUT_INSTRUCTIONS, TRANSCRIPT_JSON_INSTRUCTIONS,
} from './prompts.ts';

test('reviewer policy substitution preserves template layout and appends contract', () => {
  for (const [template, policy, expected] of [
    [' Review:\n{{ tenant_policy_config }}\nAgain: {{ tenant_policy_config }}\n \t', ' \nTenant policy.\n ', ' Review:\nTenant policy.\nAgain: Tenant policy.\n\nReview contract.\n'],
    ['Policy: {{ tenant_policy_config }}', '', 'Policy: \n\nReview contract.\n'],
    ['Tenant: {{ tenant_policy_config }}\nAdditional: {{ extra_policy }}', 'Tenant policy.', 'Tenant: Tenant policy.\nAdditional: \n\nReview contract.\n'],
    ['', 'Tenant policy.', '\n\nReview contract.\n'],
  ]) {
    assert.equal(guardianPolicyInstructions({ transcriptFormat: 'json', tenantPolicyConfig: policy, extraPolicy: '', policyTemplate: template, outputContract: 'Review contract.' }),
      `${TRANSCRIPT_JSON_INSTRUCTIONS}\n\n${expected}`);
  }
});

test('reviewer extra policy substitution preserves tenant policy', () => {
  for (const [template, extraPolicy, expected] of [
    ['Tenant: {{ tenant_policy_config }}\nAdditional: {{ extra_policy }}\nAgain: {{ extra_policy }}', ' \nAdditional policy.\n ',
      'Tenant: Tenant policy.\nAdditional: Additional policy.\nAgain: Additional policy.\n\nReview contract.\n'],
    ['Tenant: {{ tenant_policy_config }}\nAdditional: {{ extra_policy }}', ' \n\t', 'Tenant: Tenant policy.\nAdditional: \n\nReview contract.\n'],
    ['Tenant: {{ tenant_policy_config }}', 'Additional policy.', 'Tenant: Tenant policy.\n\nReview contract.\n'],
  ]) {
    assert.equal(guardianPolicyInstructions({ transcriptFormat: 'json', tenantPolicyConfig: 'Tenant policy.', extraPolicy, policyTemplate: template, outputContract: 'Review contract.' }),
      `${TRANSCRIPT_JSON_INSTRUCTIONS}\n\n${expected}`);
  }
});

test('reviewer policy substitution keeps inserted policy text literal', () => {
  assert.equal(guardianPolicyInstructions({
    transcriptFormat: 'json',
    tenantPolicyConfig: 'Tenant says {{ tenant_policy_config }} and {{ extra_policy }}.',
    extraPolicy: 'Additional says {{ tenant_policy_config }} and {{ extra_policy }}.',
    policyTemplate: 'Tenant: {{ tenant_policy_config }}\nAdditional: {{ extra_policy }}',
    outputContract: 'Review contract.',
  }), `${TRANSCRIPT_JSON_INSTRUCTIONS}\n\nTenant: Tenant says {{ tenant_policy_config }} and {{ extra_policy }}.\nAdditional: Additional says {{ tenant_policy_config }} and {{ extra_policy }}.\n\nReview contract.\n`);
});

test('line transcripts omit the JSON provenance preamble', () => {
  assert.equal(guardianPolicyInstructions({ transcriptFormat: 'line', tenantPolicyConfig: 'P', extraPolicy: '', policyTemplate: 'T {{ tenant_policy_config }}', outputContract: 'C' }), 'T P\n\nC\n');
});

test('rejection feedback trims rationale and preserves instruction overrides', () => {
  for (const [rationale, instructions, expected] of [
    [' \nSensitive data would leave the workspace.\t ', ' Ask for approval.\n',
      'This action was rejected due to unacceptable risk.\nReason: Sensitive data would leave the workspace.\n Ask for approval.\n'],
    [' \n\t', '', 'This action was rejected due to unacceptable risk.\nReason: Auto-reviewer denied the action without a specific rationale.\n'],
  ]) {
    assert.equal(renderGuardianRejection(rationale, instructions), expected);
  }
});

test('bundled policy and feedback retain the Codex contract', () => {
  assert.ok(GUARDIAN_POLICY.startsWith('## Environment Profile\n'));
  assert.ok(GUARDIAN_POLICY_TEMPLATE.includes('{{ tenant_policy_config }}') && GUARDIAN_POLICY_TEMPLATE.includes('{{ extra_policy }}'));
  assert.equal(REJECTION_INSTRUCTIONS, 'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input.');
  assert.equal(TIMEOUT_INSTRUCTIONS, 'The automatic permission approval review did not finish before its deadline. Do not assume the action is unsafe based on the timeout alone. You may retry once, or ask the user for guidance or explicit approval.');
});
