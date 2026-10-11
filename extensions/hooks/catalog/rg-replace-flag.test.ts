import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withHooks } from '../test-support.ts';
import { catalog } from './index.ts';

const note = '[hooks: rg-replace-flag] In rg, -r means --replace: it rewrites each match in the output and does not mean recursive. rg already searches recursively, so drop -r unless you meant to replace.';

test('rg replacement flags get a note after the output, and other uses of rg do not', async () => {
  await withHooks([...catalog], 'hooks:\n  rg-replace-flag: true\n', async ({ emit }) => {
    const advice = async (command: string, toolName = 'bash') => {
      const result = await emit('tool_result', { toolName, toolCallId: 'call', input: { command }, content: [{ type: 'text', text: 'out' }], isError: false });
      return result?.content?.at(-1)?.text;
    };
    for (const command of [
      'rg -r foo src', 'rg -rn TODO', 'rg -nr TODO', 'rg -nrfoo TODO', 'rg --replace=x TODO', 'rg --replace x TODO',
      'rg TODO -r x', 'rg "-r" x TODO', 'rg -tpy -r x TODO', 'cd src && rg -i -r x TODO', '/usr/bin/rg -r x TODO', 'LC_ALL=C rg -r x TODO',
    ]) assert.equal(await advice(command), note, command);
    for (const command of [
      'rg TODO', 'rg -n TODO src', 'rg -e -r TODO', 'rg -er TODO', 'rg -g -r TODO', 'rg --glob -r TODO', 'rg --glob=-r TODO',
      'rg -- -r', 'rg TODO -- -r', 'echo rg -r x', 'grep -r TODO .', 'rgx -r x', 'rg --type-add -r TODO',
    ]) assert.equal(await advice(command), undefined, command);
    assert.equal(await advice('rg -r x TODO', 'read'), undefined);
  });
});
