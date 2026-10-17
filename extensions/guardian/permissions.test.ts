// Ported from openai/codex codex-rs/prompts/src/permissions_instructions_tests.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// Model-catalog overrides, granular policies, and request_permissions have no counterpart here.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalText, formatAllowPrefixes, MAX_PERMISSION_PATH_BYTES, OMITTED_PERMISSION_PATHS, permissionsInstructions,
  type PermissionsRenderContext, sandboxText,
} from './permissions.ts';

const WORKSPACE_CONTEXT: PermissionsRenderContext = {
  sandboxMode: 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'on-request', reviewer: 'user',
  approvedCommandPrefixes: [], writableRoots: [],
};

test('renders sandbox mode text', () => {
  assert.equal(sandboxText('workspace-write', 'restricted'),
    'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is restricted.');
  assert.equal(sandboxText('read-only', 'restricted'),
    'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is restricted.');
  assert.equal(sandboxText('danger-full-access', 'enabled'),
    'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.');
});

test('sections are newline-separated with a leading newline like Codex append_section', () => {
  const text = permissionsInstructions({ ...WORKSPACE_CONTEXT, approvalPolicy: 'never', writableRoots: ['/work'] });
  assert.equal(text, `\n${sandboxText('workspace-write', 'enabled')}\n${approvalText('never', 'user', [])} The writable root is \`/work\`.\n`);
});

test('includes request rule instructions for on request', () => {
  const text = permissionsInstructions({ ...WORKSPACE_CONTEXT, approvedCommandPrefixes: [['git', 'pull']] });
  assert.ok(text.includes('prefix_rule'));
  assert.ok(text.includes('Approved command prefixes'));
  assert.ok(text.includes('["git", "pull"]'));
  assert.ok(text.includes('Network access is enabled.'));
  assert.ok(text.includes('How to request escalation'));
});

test('auto review approvals append auto review specific guidance', () => {
  const text = approvalText('on-request', 'auto_review', []);
  assert.ok(text.includes('`approvals_reviewer` is `auto_review`'));
  assert.ok(!text.includes('`approvals_reviewer` is `guardian_subagent`'));
  assert.ok(text.includes('materially safer alternative'));
});

test('auto review approvals omit auto review specific guidance when approval is never', () => {
  const text = approvalText('never', 'auto_review', []);
  assert.ok(!text.includes('`approvals_reviewer` is `auto_review`'));
});

test('preserves supplied path spellings and order', () => {
  const text = permissionsInstructions({ ...WORKSPACE_CONTEXT, writableRoots: ['/work/z', '/work/a'] });
  assert.ok(text.endsWith('\n The writable roots are `/work/z`, `/work/a`.\n'), text);
  assert.ok(permissionsInstructions({ ...WORKSPACE_CONTEXT, writableRoots: ['/work'] }).endsWith('\n The writable root is `/work`.\n'));
});

test('bounds permission paths at whole entry boundaries', () => {
  const writable = `/writable/${'é'.repeat(6_000)}`;
  const oversized = `/oversized/${'x'.repeat(MAX_PERMISSION_PATH_BYTES)}`;
  const text = permissionsInstructions({ ...WORKSPACE_CONTEXT, writableRoots: [oversized, writable] });
  const expected = permissionsInstructions({ ...WORKSPACE_CONTEXT, writableRoots: [writable] });
  assert.equal(text, `${expected}${OMITTED_PERMISSION_PATHS}\n`);
});

test('format allow prefixes sorts by length then size then tokens and quotes as JSON', () => {
  assert.equal(formatAllowPrefixes([['npm', 'run', 'dev'], ['gh', 'pr', 'check'], ['ls']]), '- ["ls"]\n- ["gh", "pr", "check"]\n- ["npm", "run", "dev"]');
  assert.equal(formatAllowPrefixes([]), undefined);
  const many = Array.from({ length: 101 }, (_, index) => [`cmd${String(index).padStart(3, '0')}`]);
  assert.ok(formatAllowPrefixes(many)!.endsWith('...\n[Some commands were truncated]'));
});
