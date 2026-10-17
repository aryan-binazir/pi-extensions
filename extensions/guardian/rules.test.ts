// Ported from openai/codex codex-rs/execpolicy/tests/basic.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { type Decision, type Evaluation, Policy, PolicyParser, type RuleMatch } from './rules.ts';

const allowAll = (): Decision => 'allow';
const promptAll = (): Decision => 'prompt';
const parse = (...sources: [string, string][]) => {
  const parser = new PolicyParser();
  for (const [name, source] of sources) parser.parse(name, source);
  return parser.build();
};
const prefixMatch = (matchedPrefix: string[], decision: Decision, extra: Partial<Extract<RuleMatch, { type: 'prefix' }>> = {}): RuleMatch =>
  ({ type: 'prefix', matchedPrefix, decision, ...extra });
const heuristicsMatch = (command: string[], decision: Decision): RuleMatch => ({ type: 'heuristics', command, decision });
const evaluation = (decision: Decision, matchedRules: RuleMatch[]): Evaluation => ({ decision, matchedRules });

test('basic match', () => {
  const policy = parse(['test.rules', `
prefix_rule(
    pattern = ["git", "status"],
)
`]);
  assert.deepEqual(policy.check(['git', 'status'], allowAll), evaluation('allow', [prefixMatch(['git', 'status'], 'allow')]));
});

test('justification is attached to forbidden matches', () => {
  const policy = parse(['test.rules', `
prefix_rule(
    pattern = ["rm"],
    decision = "forbidden",
    justification = "destructive command",
)
`]);
  assert.deepEqual(policy.check(['rm', '-rf', '/some/important/folder'], allowAll),
    evaluation('forbidden', [prefixMatch(['rm'], 'forbidden', { justification: 'destructive command' })]));
});

test('justification can be used with allow decision', () => {
  const policy = parse(['test.rules', `
prefix_rule(
    pattern = ["ls"],
    decision = "allow",
    justification = "safe and commonly used",
)
`]);
  assert.deepEqual(policy.check(['ls', '-l'], promptAll),
    evaluation('allow', [prefixMatch(['ls'], 'allow', { justification: 'safe and commonly used' })]));
});

test('justification cannot be empty', () => {
  assert.throws(() => parse(['test.rules', `
prefix_rule(
    pattern = ["ls"],
    decision = "prompt",
    justification = "   ",
)
`]), /invalid rule: justification cannot be empty/);
});

test('add prefix rule extends policy', () => {
  const policy = Policy.empty();
  policy.addPrefixRule(['ls', '-l'], 'prompt');
  assert.deepEqual(policy.rulesFor('ls'), [{ first: 'ls', rest: [['-l']], decision: 'prompt', justification: undefined }]);
  assert.deepEqual(policy.check(['ls', '-l', '/some/important/folder'], allowAll), evaluation('prompt', [prefixMatch(['ls', '-l'], 'prompt')]));
});

test('add prefix rule rejects empty prefix', () => {
  assert.throws(() => Policy.empty().addPrefixRule([], 'allow'), /prefix cannot be empty/);
});

test('parses multiple policy files', () => {
  const policy = parse(
    ['first.rules', 'prefix_rule(\n    pattern = ["git"],\n    decision = "prompt",\n)\n'],
    ['second.rules', 'prefix_rule(\n    pattern = ["git", "commit"],\n    decision = "forbidden",\n)\n'],
  );
  assert.deepEqual(policy.rulesFor('git'), [
    { first: 'git', rest: [], decision: 'prompt', justification: undefined },
    { first: 'git', rest: [['commit']], decision: 'forbidden', justification: undefined },
  ]);
  assert.deepEqual(policy.check(['git', 'status'], allowAll), evaluation('prompt', [prefixMatch(['git'], 'prompt')]));
  assert.deepEqual(policy.check(['git', 'commit', '-m', 'hi'], allowAll),
    evaluation('forbidden', [prefixMatch(['git'], 'prompt'), prefixMatch(['git', 'commit'], 'forbidden')]));
});

test('only first token alias expands to multiple rules', () => {
  const policy = parse(['test.rules', 'prefix_rule(\n    pattern = [["bash", "sh"], ["-c", "-l"]],\n)\n']);
  assert.deepEqual(policy.rulesFor('bash'), [{ first: 'bash', rest: [['-c', '-l']], decision: 'allow', justification: undefined }]);
  assert.deepEqual(policy.rulesFor('sh'), [{ first: 'sh', rest: [['-c', '-l']], decision: 'allow', justification: undefined }]);
  assert.deepEqual(policy.check(['bash', '-c', 'echo', 'hi'], allowAll), evaluation('allow', [prefixMatch(['bash', '-c'], 'allow')]));
  assert.deepEqual(policy.check(['sh', '-l', 'echo', 'hi'], allowAll), evaluation('allow', [prefixMatch(['sh', '-l'], 'allow')]));
});

test('tail aliases are not cartesian expanded', () => {
  const policy = parse(['test.rules', 'prefix_rule(\n    pattern = ["npm", ["i", "install"], ["--legacy-peer-deps", "--no-save"]],\n)\n']);
  assert.deepEqual(policy.rulesFor('npm'), [
    { first: 'npm', rest: [['i', 'install'], ['--legacy-peer-deps', '--no-save']], decision: 'allow', justification: undefined },
  ]);
  assert.deepEqual(policy.check(['npm', 'i', '--legacy-peer-deps'], allowAll),
    evaluation('allow', [prefixMatch(['npm', 'i', '--legacy-peer-deps'], 'allow')]));
  assert.deepEqual(policy.check(['npm', 'install', '--no-save', 'leftpad'], allowAll),
    evaluation('allow', [prefixMatch(['npm', 'install', '--no-save'], 'allow')]));
});

test('match and not_match examples are enforced', () => {
  const policy = parse(['test.rules', `
prefix_rule(
    pattern = ["git", "status"],
    match = [["git", "status"], "git status"],
    not_match = [
        ["git", "--config", "color.status=always", "status"],
        "git --config color.status=always status",
    ],
)
`]);
  assert.deepEqual(policy.check(['git', 'status'], allowAll), evaluation('allow', [prefixMatch(['git', 'status'], 'allow')]));
  const command = ['git', '--config', 'color.status=always', 'status'];
  assert.deepEqual(policy.check(command, allowAll), evaluation('allow', [heuristicsMatch(command, 'allow')]));
});

test('failing examples reject the rules file', () => {
  assert.throws(() => parse(['test.rules', 'prefix_rule(pattern = ["git", "status"], match = ["git commit"])']), /expected every example to match at least one rule/);
  assert.throws(() => parse(['test.rules', 'prefix_rule(pattern = ["git"], not_match = ["git status"])']), /expected example to not match rule/);
});

test('strictest decision wins across matches', () => {
  const policy = parse(['test.rules', 'prefix_rule(\n    pattern = ["git"],\n    decision = "prompt",\n)\nprefix_rule(\n    pattern = ["git", "commit"],\n    decision = "forbidden",\n)\n']);
  assert.deepEqual(policy.check(['git', 'commit', '-m', 'hi'], allowAll),
    evaluation('forbidden', [prefixMatch(['git'], 'prompt'), prefixMatch(['git', 'commit'], 'forbidden')]));
});

test('strictest decision across multiple commands', () => {
  const policy = parse(['test.rules', 'prefix_rule(\n    pattern = ["git"],\n    decision = "prompt",\n)\nprefix_rule(\n    pattern = ["git", "commit"],\n    decision = "forbidden",\n)\n']);
  assert.deepEqual(policy.checkMultiple([['git', 'status'], ['git', 'commit', '-m', 'hi']], allowAll),
    evaluation('forbidden', [prefixMatch(['git'], 'prompt'), prefixMatch(['git'], 'prompt'), prefixMatch(['git', 'commit'], 'forbidden')]));
});

test('heuristics match is returned when no policy matches', () => {
  assert.deepEqual(Policy.empty().check(['python'], promptAll), evaluation('prompt', [heuristicsMatch(['python'], 'prompt')]));
});

test('parses host executable paths', () => {
  const policy = parse(['test.rules', `
host_executable(
    name = "git",
    paths = [
        "/opt/homebrew/bin/git",
        "/usr/bin/git",
        "/usr/bin/git",
    ],
)
`]);
  assert.deepEqual(policy.hostExecutables.get('git'), ['/opt/homebrew/bin/git', '/usr/bin/git']);
});

test('host executable rejects non-absolute path', () => {
  assert.throws(() => parse(['test.rules', 'host_executable(name = "git", paths = ["git"])']), /host_executable paths must be absolute/);
});

test('host executable rejects name with path separator', () => {
  assert.throws(() => parse(['test.rules', 'host_executable(name = "/usr/bin/git", paths = ["/usr/bin/git"])']),
    /host_executable name must be a bare executable name/);
});

test('host executable rejects path with wrong basename', () => {
  assert.throws(() => parse(['test.rules', 'host_executable(name = "git", paths = ["/usr/bin/rg"])']), /must have basename `git`/);
});

test('host executable last definition wins', () => {
  const policy = parse(
    ['shared.rules', 'host_executable(name = "git", paths = ["/usr/bin/git"])'],
    ['user.rules', 'host_executable(name = "git", paths = ["/opt/homebrew/bin/git"])'],
  );
  assert.deepEqual(policy.hostExecutables.get('git'), ['/opt/homebrew/bin/git']);
});

test('host executable resolution uses basename rule when allowed', () => {
  const policy = parse(['test.rules', 'prefix_rule(pattern = ["git", "status"], decision = "prompt")\nhost_executable(name = "git", paths = ["/usr/bin/git"])\n']);
  assert.deepEqual(policy.check(['/usr/bin/git', 'status'], allowAll, { resolveHostExecutables: true }),
    evaluation('prompt', [prefixMatch(['git', 'status'], 'prompt', { resolvedProgram: '/usr/bin/git' })]));
});

test('prefix rule examples honor host executable resolution', () => {
  assert.doesNotThrow(() => parse(['test.rules', `
prefix_rule(
    pattern = ["git", "status"],
    match = [["/usr/bin/git", "status"]],
    not_match = [["/opt/homebrew/bin/git", "status"]],
)
host_executable(name = "git", paths = ["/usr/bin/git"])
`]));
});

test('host executable resolution respects explicit empty allowlist', () => {
  const policy = parse(['test.rules', 'prefix_rule(pattern = ["git"], decision = "prompt")\nhost_executable(name = "git", paths = [])\n']);
  assert.deepEqual(policy.check(['/usr/bin/git', 'status'], allowAll, { resolveHostExecutables: true }),
    evaluation('allow', [heuristicsMatch(['/usr/bin/git', 'status'], 'allow')]));
});

test('host executable resolution ignores path not in allowlist', () => {
  const policy = parse(['test.rules', 'prefix_rule(pattern = ["git"], decision = "prompt")\nhost_executable(name = "git", paths = ["/usr/bin/git"])\n']);
  assert.deepEqual(policy.check(['/opt/homebrew/bin/git', 'status'], allowAll, { resolveHostExecutables: true }),
    evaluation('allow', [heuristicsMatch(['/opt/homebrew/bin/git', 'status'], 'allow')]));
});

test('host executable resolution falls back without mapping', () => {
  const policy = parse(['test.rules', 'prefix_rule(pattern = ["git"], decision = "prompt")\n']);
  assert.deepEqual(policy.check(['/usr/bin/git', 'status'], allowAll, { resolveHostExecutables: true }),
    evaluation('prompt', [prefixMatch(['git'], 'prompt', { resolvedProgram: '/usr/bin/git' })]));
});

test('host executable resolution does not override exact match', () => {
  const policy = parse(['test.rules', 'prefix_rule(pattern = ["/usr/bin/git"], decision = "allow")\nprefix_rule(pattern = ["git"], decision = "prompt")\nhost_executable(name = "git", paths = ["/usr/bin/git"])\n']);
  assert.deepEqual(policy.check(['/usr/bin/git', 'status'], allowAll, { resolveHostExecutables: true }),
    evaluation('allow', [prefixMatch(['/usr/bin/git'], 'allow')]));
});

test('allowed prefixes render alternatives for permission instructions', () => {
  const policy = parse(['test.rules', 'prefix_rule(pattern = ["npm", ["i", "install"]])\nprefix_rule(pattern = ["git", "push"], decision = "prompt")\n']);
  assert.deepEqual(policy.allowedPrefixes(), [['npm', '[i|install]']]);
});

test('starlark syntax subset: comments, trailing commas, single quotes and escapes', () => {
  const policy = parse(['test.rules', `
# Comments are ignored.
prefix_rule(pattern = ['echo', "say \\"hi\\""], decision = 'forbidden', justification = 'Use printf.',)  # trailing comment
`]);
  assert.deepEqual(policy.check(['echo', 'say "hi"'], allowAll),
    evaluation('forbidden', [prefixMatch(['echo', 'say "hi"'], 'forbidden', { justification: 'Use printf.' })]));
});

test('invalid syntax and unknown builtins are rejected with the file name', () => {
  assert.throws(() => parse(['broken.rules', 'prefix_rule(pattern = ["git"]']), /broken\.rules/);
  assert.throws(() => parse(['broken.rules', 'evil_rule(pattern = ["git"])']), /broken\.rules.*evil_rule/s);
  assert.throws(() => parse(['broken.rules', 'prefix_rule(pattern = [])']), /pattern cannot be empty/);
  assert.throws(() => parse(['broken.rules', 'prefix_rule(pattern = ["git"], decision = "maybe")']), /invalid decision: maybe/);
});
