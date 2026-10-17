// Ported from openai/codex codex-rs/ext/guardian-reviewer/src/assessment_tests.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GUARDIAN_OUTPUT_CONTRACT_PROMPT, GUARDIAN_OUTPUT_SCHEMA, parseGuardianAssessment } from './assessment.ts';

test('parse guardian assessment extracts embedded json', () => {
  assert.deepEqual(parseGuardianAssessment('preface {"risk_level":"medium","user_authorization":"low","outcome":"allow","rationale":"ok"}'),
    { riskLevel: 'medium', userAuthorization: 'low', outcome: 'allow', rationale: 'ok' });
});

test('parse guardian assessment treats bare allow as low risk', () => {
  assert.deepEqual(parseGuardianAssessment('{"outcome":"allow"}'),
    { riskLevel: 'low', userAuthorization: 'unknown', outcome: 'allow', rationale: 'Auto-review returned a low-risk allow decision.' });
});

test('parse guardian assessment treats bare deny as high risk', () => {
  assert.deepEqual(parseGuardianAssessment('{"outcome":"deny"}'),
    { riskLevel: 'high', userAuthorization: 'unknown', outcome: 'deny', rationale: 'Auto-review returned a deny decision without a rationale.' });
});

test('parse guardian assessment rejects non-json and invalid enums', () => {
  assert.throws(() => parseGuardianAssessment('looks fine to me'), /guardian assessment was not valid JSON/);
  assert.throws(() => parseGuardianAssessment('{"outcome":"maybe"}'), /outcome/);
  assert.throws(() => parseGuardianAssessment('{"outcome":"allow","risk_level":"severe"}'), /risk_level/);
  assert.throws(() => parseGuardianAssessment('{"risk_level":"low"}'), /outcome/);
});

test('output contract and schema stay aligned', () => {
  assert.deepEqual(GUARDIAN_OUTPUT_SCHEMA.required, ['outcome']);
  assert.ok(GUARDIAN_OUTPUT_CONTRACT_PROMPT.includes('{"outcome":"allow"}'));
  assert.ok(GUARDIAN_OUTPUT_CONTRACT_PROMPT.endsWith('"rationale": string\n}'));
});
