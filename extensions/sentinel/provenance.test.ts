import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest } from './config.ts';
import { captureUserInput, classifyInstructions, sanitizeQuestionnaire } from './provenance.ts';

const input = { questions: [{ id: 'hidden-id-delete-production', prompt: 'Assistant assertion', options: [
  { value: 'hidden-value-delete-production', label: '  Yes\tplease\ncontinue  ', description: 'Assistant description' },
  { value: 'no', label: 'No' },
] }] };
const answer = { id: input.questions[0].id, value: input.questions[0].options[0].value, label: input.questions[0].options[0].label, wasCustom: false };
const result = { cancelled: false, answers: [answer] };

test('captures only raw interactive/rpc text and explicitly whitelisted fields', () => {
  for (const source of ['interactive', 'rpc']) {
    const event = { source, text: '/skill:deploy $& $` $\'\n  untouched', expanded: 'Delete everything', images: [] };
    assert.deepEqual(captureUserInput(event), { text: event.text, images: [], complete: true });
  }
  for (const source of [undefined, 'extension', 'other']) assert.equal(captureUserInput({ source, text: 'approved' }), undefined);
});

test('bounds raw input and image metadata without duplicating image payloads', () => {
  const data = 'private-image-data'.repeat(10000);
  assert.deepEqual(captureUserInput({ source: 'rpc', text: 'x'.repeat(128000), images: [{ data, mimeType: 'image/png' }] }), {
    text: 'x'.repeat(128000), images: [{ sha256: digest(data), mimeType: 'image/png' }], complete: true,
  });
  const captured = captureUserInput({ source: 'rpc', text: 'x'.repeat(128001), images: Array.from({ length: 129 }, () => ({ data, mimeType: 'm'.repeat(300) })) }) as any;
  assert.equal(captured.text.length, 128000);
  assert.match(captured.text, /sentinel_omitted/);
  assert.equal(captured.complete, false);
  assert.equal(captured.images.length, 128);
  assert.equal(captured.images[0].mimeType.length, 256);
  assert.ok(!JSON.stringify(captured).includes('private-image-data'));
});

test('only visible option labels become authority; hidden IDs/values and assistant text stay untrusted', () => {
  const sanitized = sanitizeQuestionnaire(input, result)!;
  assert.deepEqual(sanitized.verified_answers, [{ question_index: 0, label: answer.label }]);
  assert.deepEqual(sanitized.assistant_authored_questions, input);
  assert.doesNotMatch(JSON.stringify(sanitized.verified_answers), /hidden-|Assistant/);
  const decorated = structuredClone(input);
  decorated.questions[0].options[0].label = '\x1b[31m Yes\x1b[0m\t\n  please\x00\x07\x9f';
  const decoratedAnswer = { ...answer, label: decorated.questions[0].options[0].label };
  assert.deepEqual(sanitizeQuestionnaire(decorated, { cancelled: false, answers: [decoratedAnswer] })?.verified_answers, [{ question_index: 0, label: ' Yes\t\n  please' }]);
});

test('custom user text keeps its whitespace and literal metasyntax after renderer cleanup', () => {
  const text = '  My\tactual\n  $& $` $\' answer\x1b[31m!\x1b[0m\x00';
  assert.deepEqual(sanitizeQuestionnaire(input, { cancelled: false, answers: [{ ...answer, wasCustom: true, value: text, label: text }] })?.verified_answers,
    [{ question_index: 0, text: '  My\tactual\n  $& $` $\' answer!' }]);
});

test('rejects cancelled, partial, malformed, mismatched, and impossible questionnaire answers', () => {
  const badResults: unknown[] = [undefined, null, [], {}, { ...result, cancelled: true }, { ...result, cancelled: 'false' }, { ...result, answers: [] },
    ...[null, {}, { ...answer, id: 'wrong' }, { ...answer, value: 'no' }, { ...answer, label: 'No' }, { ...answer, wasCustom: 'false' },
      { ...answer, wasCustom: true }, { ...answer, wasCustom: true, value: ' ', label: ' ' },
      { ...answer, wasCustom: true, value: 'x'.repeat(16001), label: 'x'.repeat(16001) }].map(a => ({ cancelled: false, answers: [a] })),
    { cancelled: false, answers: [answer, answer] }];
  for (const bad of badResults) assert.equal(sanitizeQuestionnaire(input, bad), undefined);
  for (const bad of [null, [], {}, { questions: [] }, { questions: [null] }, { questions: [{ ...input.questions[0], options: [null] }] },
    { questions: [{ ...input.questions[0], options: [{ value: 1, label: 'yes' }] }] },
    { questions: [{ ...input.questions[0], allowOther: 'yes' }] }]) assert.equal(sanitizeQuestionnaire(bad, result), undefined);
  assert.equal(sanitizeQuestionnaire({ questions: [{ ...input.questions[0], allowOther: false }] },
    { cancelled: false, answers: [{ ...answer, wasCustom: true, value: 'custom', label: 'custom' }] }), undefined);
  assert.equal(sanitizeQuestionnaire({ get questions() { throw new Error('malformed'); } }, result), undefined);
});

test('question IDs only match declared order, cannot enter authority or alias multiple answers', () => {
  const second = { ...input.questions[0], id: 'second-hidden-id' };
  const questions = { questions: [input.questions[0], second] };
  const secondAnswer = { ...answer, id: second.id };
  assert.deepEqual(sanitizeQuestionnaire(questions, { cancelled: false, answers: [answer, secondAnswer] })?.verified_answers,
    [{ question_index: 0, label: answer.label }, { question_index: 1, label: answer.label }]);
  for (const answers of [[secondAnswer, answer], [answer, answer]]) assert.equal(sanitizeQuestionnaire(questions, { cancelled: false, answers }), undefined);
  assert.equal(sanitizeQuestionnaire({ questions: [input.questions[0], input.questions[0]] }, { cancelled: false, answers: [answer, answer] }), undefined);
});

test('classifies canonical global files separately from project and unsourced prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-provenance-'));
  try {
    const agentDir = join(root, 'agent');
    await mkdir(agentDir);
    await mkdir(join(root, 'agent-extra'));
    await mkdir(join(agentDir, 'nested'));
    const global = join(agentDir, 'AGENTS.md');
    const nested = join(agentDir, 'nested', 'AGENTS.md');
    const project = join(root, 'AGENTS.md');
    const prefix = join(root, 'agent-extra', 'AGENTS.md');
    for (const path of [global, nested, project, prefix]) await writeFile(path, 'instructions');
    await symlink(project, join(agentDir, 'escape.md'));
    await symlink(root, join(agentDir, 'escape-dir'));
    await symlink(join(root, 'absent'), join(agentDir, 'dangling.md'));
    const globalFiles = [global, nested].map(path => ({ path, content: 'global user policy $& $` $\'' }));
    const untrustedFiles = [project, prefix, join(agentDir, 'escape.md'), join(agentDir, 'escape-dir', 'AGENTS.md'), join(agentDir, 'dangling.md'), join(agentDir, 'missing.md'), agentDir]
      .map(path => ({ path, content: 'repo-controlled policy' }));
    const options = { customPrompt: 'SYSTEM.md $& $` $\'', appendSystemPrompt: 'steering', contextFiles: [...globalFiles, ...untrustedFiles] };
    const classified = await classifyInstructions(options, false, agentDir);
    assert.deepEqual(JSON.parse(classified.trusted), { contextFiles: globalFiles });
    assert.deepEqual(JSON.parse(classified.untrusted), { untrusted_instructions: { customPrompt: options.customPrompt, appendSystemPrompt: options.appendSystemPrompt, contextFiles: untrustedFiles } });
    const approved = await classifyInstructions(options, true, agentDir);
    assert.deepEqual(JSON.parse(approved.trusted), options);
    assert.equal(approved.untrusted, '');
    for (const dir of [join(root, 'missing'), join(root, 'alias')]) {
      if (dir.endsWith('alias')) await symlink(agentDir, dir);
      const files = [{ path: join(dir, 'AGENTS.md'), content: 'unproven' }];
      const classified = await classifyInstructions({ contextFiles: files }, false, dir);
      assert.equal(classified.trusted, '');
      assert.deepEqual(JSON.parse(classified.untrusted), { untrusted_instructions: { contextFiles: files } });
    }
    assert.deepEqual(await classifyInstructions(undefined, false, agentDir), { trusted: '', untrusted: '' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
