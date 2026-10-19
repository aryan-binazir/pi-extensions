// Ported from openai/codex codex-rs/execpolicy/src/amend.rs and tests/basic.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { appendAllowPrefixRule } from './amend.ts';
import { PolicyParser } from './rules.ts';

async function policyPath(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-amend-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'rules', 'default.rules');
}

test('appends rule and creates directories', async t => {
  const path = await policyPath(t);
  await appendAllowPrefixRule(path, ['echo', 'Hello, world!']);
  assert.equal(await readFile(path, 'utf8'), 'prefix_rule(pattern=["echo", "Hello, world!"], decision="allow")\n');
});

test('appends rule without duplicate newline', async t => {
  const path = await policyPath(t);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'prefix_rule(pattern=["ls"], decision="allow")\n');
  await appendAllowPrefixRule(path, ['echo', 'Hello, world!']);
  assert.equal(await readFile(path, 'utf8'),
    'prefix_rule(pattern=["ls"], decision="allow")\nprefix_rule(pattern=["echo", "Hello, world!"], decision="allow")\n');
});

test('inserts newline when missing before append', async t => {
  const path = await policyPath(t);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'prefix_rule(pattern=["ls"], decision="allow")');
  await appendAllowPrefixRule(path, ['echo', 'Hello, world!']);
  assert.equal(await readFile(path, 'utf8'),
    'prefix_rule(pattern=["ls"], decision="allow")\nprefix_rule(pattern=["echo", "Hello, world!"], decision="allow")\n');
});

test('append allow prefix rule dedupes existing rule', async t => {
  const path = await policyPath(t);
  await appendAllowPrefixRule(path, ['python3']);
  await appendAllowPrefixRule(path, ['python3']);
  assert.equal(await readFile(path, 'utf8'), 'prefix_rule(pattern=["python3"], decision="allow")\n');
});

test('rejects an empty prefix', async t => {
  await assert.rejects(appendAllowPrefixRule(await policyPath(t), []), /prefix rule requires at least one token/);
});

test('appended rules parse back to the same prefix, including escaped tokens', async t => {
  const path = await policyPath(t);
  const prefix = ['printf', 'quote " back \\ tab \t bell \b feed \f nul \0 é🙂'];
  await appendAllowPrefixRule(path, prefix);
  const parser = new PolicyParser();
  parser.parse('default.rules', await readFile(path, 'utf8'));
  assert.deepEqual(parser.build().check([...prefix, 'more'], () => 'prompt').matchedRules,
    [{ type: 'prefix', matchedPrefix: prefix, decision: 'allow' }]);
});
