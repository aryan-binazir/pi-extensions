import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const virtualHost = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';
import * as ai from '@earendil-works/pi-ai/compat';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

const source = ts.transpileModule(await readFile(process.argv[1], 'utf8'), {
 compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const host = new SyntheticModule(Object.keys(ai), function() {
 for (const [name, value] of Object.entries(ai)) this.setExport(name, value);
});
let filesystemResolutions = 0;
const extension = new SourceTextModule(source, {
 initializeImportMeta(meta) {
  meta.resolve = () => { filesystemResolutions++; throw new Error('Host modules are virtual'); };
 },
 importModuleDynamically() { throw new Error('No filesystem host modules'); },
});
await extension.link(specifier => {
 assert.equal(specifier, '@earendil-works/pi-ai');
 return host;
});
await extension.evaluate();
assert.equal(filesystemResolutions, 0, 'Fast mode must not resolve a filesystem host package');
for (const original of [openaiProvider(), openaiCodexProvider()]) {
 const provider = extension.namespace.withFastModels(original);
 const base = original.getModels().find(model => model.id === 'gpt-5.5') ?? original.getModels()[0];
 const alias = provider.getModels().find(model => model.id === base.id + '~fast');
 assert.ok(alias, original.id + ' must expose a fast alias through a virtual-only host');
 const apiKey = original.id === 'openai-codex'
  ? 'fixture.' + Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture-account'}})).toString('base64url') + '.fixture'
  : 'fixture-key';
 for (const serviceTier of [undefined, 'priority', 'default']) {
  let payload;
  const fetch = async (_url, init) => {
   const headers = new Headers(init.headers);
   const body = headers.get('content-encoding') === 'zstd'
    ? (await import('node:zlib')).zstdDecompressSync(init.body).toString()
    : String(init.body);
   payload = JSON.parse(body);
   return new Response('data: ' + JSON.stringify({type: 'response.completed', response: {
    status: 'completed', service_tier: serviceTier,
    usage: {input_tokens: 1000, output_tokens: 100, input_tokens_details: {cached_tokens: 0}},
   }}) + '\n\n', {headers: {'content-type': 'text/event-stream'}});
  };
  const output = await provider.streamSimple(alias, ai.normalizeContext({messages: []}), {
   apiKey, fetch, reasoning: 'low', transport: 'sse', maxRetries: 0,
  }).result();
  assert.equal(output.stopReason, 'stop', output.errorMessage);
  assert.equal(payload.model, base.id);
  assert.equal(payload.service_tier, 'priority');
  assert.equal(payload.reasoning.effort, 'low');
  const multiplier = serviceTier === 'default' ? 1 : base.id === 'gpt-5.5' ? 2.5 : 2;
  assert.equal(output.usage.cost.input, base.cost.input * 0.001 * multiplier);
 }
}
`;

test('virtual-only Pi host registers fast aliases and preserves priority request pricing', () => {
 const result = spawnSync(process.execPath, [
  '--experimental-vm-modules', '--input-type=module', '-e', virtualHost,
  new URL('./provider.ts', import.meta.url).pathname,
 ], { encoding: 'utf8', timeout: 30000 });
 assert.equal(result.status, 0, result.stderr || result.stdout);
});
