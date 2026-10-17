// Ported from openai/codex codex-rs/execpolicy/src/amend.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// Codex holds an advisory lock while deduping. Node has no flock, so this appends in one O_APPEND write;
// a concurrent duplicate line yields the same decision.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendAllowPrefixRule(policyPath: string, prefix: readonly string[]): Promise<void> {
  if (!prefix.length) throw new Error('prefix rule requires at least one token');
  const pattern = `[${prefix.map(token => JSON.stringify(token)).join(', ')}]`;
  await appendRuleLine(policyPath, `prefix_rule(pattern=${pattern}, decision="allow")`);
}

async function appendRuleLine(policyPath: string, line: string): Promise<void> {
  await mkdir(dirname(policyPath), { recursive: true });
  let contents = '';
  try {
    contents = await readFile(policyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (contents.split('\n').includes(line)) return;
  const separator = contents && !contents.endsWith('\n') ? '\n' : '';
  await appendFile(policyPath, `${separator}${line}\n`);
}
