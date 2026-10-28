import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditStats, formatText } from './audit-stats.ts';
import { APPROVAL_AUDIT_ENTRY_TYPE } from './approvals.ts';

function entry(data: Record<string, unknown> = {}) {
  return { type: 'custom', customType: 'guardian-approval-decision', data: {
    version: 1, sessionId: 'synthetic-session', requestId: 'request-1', timestamp: '2026-01-01T00:00:00Z',
    decider: 'auto_review', verdict: 'approved', durationMs: 10,
    actionJson: JSON.stringify({ tool: 'bash', command: ['bash', '-lc', 'git status'] }), ...data,
  } };
}

async function* jsonl(values: unknown[]) {
  yield Buffer.from(values.map(value => JSON.stringify(value)).join('\n'));
}

test('aggregates legacy decisions without disclosing their metadata', async () => {
  assert.equal(entry().customType, APPROVAL_AUDIT_ENTRY_TYPE);
  const result = await auditStats([jsonl([entry()])]);
  assert.equal(result.records.audit, 1);
  assert.equal(result.records.distinct, 1);
  assert.equal(result.requests.unique, 1);
  assert.deepEqual(result.durationMs, { count: 1, excluded: 0, total: 10, p50: 10, p90: 10, p95: 10 });
  assert.equal(result.byOperation.git.records, 1);
  assert.equal(result.byDecider.auto_review.records, 1);
  assert.equal(result.requests.outcomes.approved, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-session|request-1|git status|2026-01/);
});

test('separates copied records, additional decisions, request outcomes and manual handling', async () => {
  const automatic = entry({ verdict: 'error' });
  const user = entry({ decider: 'user', durationMs: 20, timestamp: 'later', userChoice: 'approve' });
  const denial = entry({ requestId: 'request-2', verdict: 'rejected', durationMs: 50 });
  const manual = entry({ requestId: 'request-2', decider: 'user', userChoice: 'manual', durationMs: 0 });
  const copy = { ...automatic, id: 'different-envelope', data: Object.fromEntries(Object.entries(automatic.data).reverse()) };
  const unkeyed = entry({ requestId: undefined, decider: 'policy', verdict: 'rejected', durationMs: 5 });
  const result = await auditStats([jsonl([automatic, user, denial]), jsonl([manual, copy, unkeyed])]);
  assert.deepEqual(result.records, { audit: 6, distinct: 5, duplicates: 1 });
  assert.equal(result.requests.unique, 2);
  assert.equal(result.requests.unkeyedRecords, 1);
  assert.equal(result.requests.withMultipleDecisions, 2);
  assert.equal(result.requests.additionalDecisions, 2);
  assert.equal(result.requests.autoAndPromptUser, 1);
  assert.equal(result.requests.manualApprovals, 1);
  assert.deepEqual(result.requests.outcomes, { approved: 2, rejected: 1, aborted: 0, error: 1, unknown: 0 });
  assert.deepEqual(result.byPhase.manual_approval.durationMs, { count: 1, excluded: 0, total: 0, p50: 0, p90: 0, p95: 0 });
  assert.equal(result.byPhase.user_prompt.durationMs.total, 20);
  assert.equal(result.durationMs.total, 85);
  const reversed = await auditStats([jsonl([unkeyed, copy, manual, denial, user, automatic])]);
  for (const key of ['records', 'requests', 'durationMs', 'byDecider', 'byPhase', 'byVerdict', 'byOperation'] as const) assert.deepEqual(reversed[key], result[key]);
});

test('bounds byte lines, recovers after malformed and oversized data, and tolerates missing fields', async () => {
  const limit = 512;
  const unicode = JSON.stringify(entry({ requestId: 'unicode', summary: '秘密🔑' }));
  const exact = unicode + ' '.repeat(limit - Buffer.byteLength(unicode));
  const oversized = JSON.stringify(entry({ requestId: 'too-large' })).padEnd(limit + 1, ' ');
  const bytes = Buffer.concat([
    Buffer.from('\uFEFF\r\nmalformed-canary-secret\n' + exact + '\r\n' + oversized + '\n'),
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from([
      JSON.stringify(entry({ version: undefined })), JSON.stringify(entry({ version: 2 })),
      JSON.stringify({ type: 'custom', customType: 'guardian-approval-decision', data: [] }),
      'null', JSON.stringify(entry({ requestId: undefined, sessionId: undefined, decider: 'secret-host', verdict: undefined, durationMs: undefined })),
    ].join('\n')),
  ]);
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const result = await auditStats([chunks()], { maxLineBytes: limit });
  assert.equal(result.complete, false);
  assert.deepEqual(result.exclusions, { malformedJsonLines: 1, invalidUtf8Lines: 1, oversizedLines: 1, invalidAuditData: 1, unsupportedVersion: 2 });
  assert.deepEqual(result.records, { audit: 5, distinct: 2, duplicates: 0 });
  assert.equal(result.requests.unique, 1);
  assert.equal(result.requests.unkeyedRecords, 1);
  assert.equal(result.byDecider.unknown.records, 1);
  assert.equal(result.byVerdict.unknown.records, 1);
  assert.equal(result.input.blankLines, 1);
  assert.equal(result.input.nonAuditLines, 1);
  assert.equal(result.input.bytes, bytes.length);
  assert.doesNotMatch(JSON.stringify(result), /秘密|🔑|canary|secret-host|unicode/);
});

test('stops explicitly at input, distinct record and source bounds without parsing a torn prefix', async () => {
  const source = () => jsonl([entry(), entry({ requestId: 'second' })]);
  const records = await auditStats([source()], { maxRecords: 1 });
  assert.equal(records.stoppedBy, 'records');
  assert.equal(records.complete, false);
  assert.equal(records.records.distinct, 1);
  assert.equal(records.records.audit, 1);
  const bytes = await auditStats([source()], { maxInputBytes: 5 });
  assert.equal(bytes.stoppedBy, 'input_bytes');
  assert.equal(bytes.records.distinct, 0);
  assert.equal(bytes.input.bytes, 5);
  const first = JSON.stringify(entry());
  const torn = await auditStats([source()], { maxInputBytes: Buffer.byteLength(first) + 5 });
  assert.equal(torn.records.distinct, 1);
  assert.equal(torn.exclusions.malformedJsonLines, 0);
  const sources = await auditStats([source(), source()], { maxInputs: 1 });
  assert.equal(sources.stoppedBy, 'inputs');
  assert.equal(sources.input.sources, 1);
  await assert.rejects(auditStats([], { maxLineBytes: 0 }), /Invalid limits/);
});

test('uses exact nearest-rank percentiles, including small populations and ties', async () => {
  for (const [values, expected] of [
    [[7], [7, 7, 7, 7]], [[1, 9], [10, 1, 9, 9]],
    [Array.from({ length: 10 }, (_, i) => i + 1), [55, 5, 9, 10]],
    [Array.from({ length: 20 }, (_, i) => i + 1), [210, 10, 18, 19]],
    [Array.from({ length: 100 }, (_, i) => i + 1), [5050, 50, 90, 95]],
    [[0, 5, 5, 10], [20, 5, 10, 10]],
  ]) {
    const result = await auditStats([jsonl(values.map((durationMs, i) => entry({ requestId: String(i), durationMs })))]);
    assert.deepEqual(result.durationMs, { count: values.length, excluded: 0, total: expected[0], p50: expected[1], p90: expected[2], p95: expected[3] });
  }
  const empty = await auditStats([]);
  assert.deepEqual(empty.durationMs, { count: 0, excluded: 0, total: 0, p50: null, p90: null, p95: null });
});

test('excludes invalid durations by reason without losing outcomes and sums large integers exactly', async () => {
  const durations = [undefined, null, '12', true, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 0, 1, Number.MAX_SAFE_INTEGER];
  const lines = durations.map((durationMs, i) => JSON.stringify(entry({ requestId: String(i), durationMs })).replace('"durationMs":null', '"durationMs":' + (durationMs === Infinity ? '1e400' : 'null')));
  async function* input() { yield Buffer.from(lines.join('\n')); }
  const result = await auditStats([input()]);
  assert.equal(result.records.distinct, 11);
  assert.equal(result.requests.outcomes.approved, 11);
  assert.deepEqual(result.durationExclusions, { missing: 1, nonNumeric: 3, nonFinite: 1, negative: 1, notSafeInteger: 2 });
  assert.deepEqual(result.durationMs, { count: 3, excluded: 8, total: '9007199254740992', p50: 1, p90: Number.MAX_SAFE_INTEGER, p95: Number.MAX_SAFE_INTEGER });
});

test('classifies actual recorded actions conservatively, including quoted operators and compound scripts', async () => {
  const commands = [
    ['git status', 'git'], ['git commit -m "one; two"', 'git'], ['npm test', 'package'],
    ['node script.js', 'node'], ['curl https://secret.example', 'network'], ['mkdir scratch', 'filesystem'],
    ['cd /repo && git status', 'compound'], ['git status | cat', 'compound'], ['git status\nnpm test', 'compound'],
    ['git status >secret-file', 'unknown'], ['git "$(echo secret)"', 'unknown'], ['env TOKEN=secret git status', 'unknown'],
    ['/usr/bin/git status', 'unknown'], ["bash -lc 'git status'", 'unknown'], ["git 'unfinished", 'unknown'],
  ];
  const rows = commands.map(([command], i) => entry({ requestId: String(i), summary: 'git status',
    actionJson: JSON.stringify({ tool: 'bash', command: ['bash', '-lc', command] }) }));
  rows.push(entry({ requestId: 'write', actionJson: JSON.stringify({ tool: 'write', files: ['/secret'], content: 'secret' }) }));
  rows.push(entry({ requestId: 'edit', actionJson: JSON.stringify({ tool: 'edit', edits: ['secret'] }) }));
  rows.push(entry({ requestId: 'truncated', actionTruncated: true }));
  rows.push(entry({ requestId: 'bad-action', actionJson: '{secret' }));
  rows.push(entry({ requestId: 'wrong-shape', actionJson: JSON.stringify({ tool: 'bash', command: 'git status' }) }));
  const result = await auditStats([jsonl(rows)]);
  assert.deepEqual(Object.fromEntries(Object.entries(result.byOperation).map(([key, value]) => [key, value.records])), {
    git: 2, package: 1, node: 1, network: 1, filesystem: 1, file_write: 1, file_edit: 1, compound: 3, unknown: 9,
  });
  assert.equal(result.truncatedActions, 1);
  const limited = await auditStats([jsonl([entry()])], { maxScriptBytes: 1 });
  assert.equal(limited.classificationExclusions.scriptLimit, 1);
  assert.equal(limited.byOperation.unknown.records, 1);
  assert.equal(limited.complete, false);
});

test('CLI uses explicit files/stdin, reports method and limits, and never echoes sensitive inputs', async () => {
  const canary = '秘密-SYNTHETIC-CREDENTIAL-7349';
  const data = entry({ sessionId: canary, requestId: canary, rationale: canary, summary: canary,
    requestReason: canary, justification: canary, reviewer: { provider: canary, model: canary },
    extraFutureField: { canary }, actionJson: JSON.stringify({ tool: 'bash', cwd: canary, command: ['bash', '-lc', 'git status'] }) });
  const cli = (args: string[], input = '') => spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./audit-stats.ts', import.meta.url)), ...args], { input, encoding: 'utf8', timeout: 10_000 });
  for (const args of [['--json', '-'], ['-']]) {
    const child = cli(args, JSON.stringify(data));
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stdout + child.stderr, new RegExp(canary));
    if (args[0] === '--json') {
      const report = JSON.parse(child.stdout);
      assert.equal(report.records.distinct, 1);
      assert.match(report.method.join(' '), /nearest-rank/);
      assert.match(report.limitations.join(' '), /retr/i);
    } else assert.match(child.stdout, /Distinct decisions: 1/);
  }
  for (const input of [canary, JSON.stringify(data) + '\n' + canary, JSON.stringify(entry({ summary: canary.repeat(100_000) }))]) {
    const child = cli(['--json', '-'], input);
    assert.equal(child.status, 2, child.stderr);
    assert.equal(JSON.parse(child.stdout).complete, false);
    assert.doesNotMatch(child.stdout + child.stderr, new RegExp(canary));
  }
  for (const args of [[], ['--' + canary], ['-', '-'], ['--json', '/missing/' + canary]]) {
    const child = cli(args);
    assert.equal(child.status, 1);
    assert.doesNotMatch(child.stdout + child.stderr, new RegExp(canary));
    assert.doesNotMatch(child.stderr, /at |Error:|ENOENT/);
  }
  assert.match(formatText(await auditStats([])), /p50\/p90\/p95/);
});

test('keeps a decider/verdict matrix and does not invent prompt timing for missing user choice', async () => {
  const result = await auditStats([jsonl([
    entry({ verdict: 'error' }), entry({ decider: 'user', userChoice: 'approve', timestamp: 'next', durationMs: 20 }),
    entry({ requestId: 'no-choice', decider: 'user' }), entry({ requestId: 'aborted', verdict: 'aborted' }),
    entry({ requestId: 'invalid-choice', decider: 'user', userChoice: { toString: null } }),
    entry({ requestId: 'policy', decider: 'policy', verdict: 'rejected' }),
  ])]);
  assert.equal(result.decisions.auto_review.error, 1);
  assert.equal(result.decisions.auto_review.aborted, 1);
  assert.equal(result.decisions.user.approved, 3);
  assert.equal(result.decisions.policy.rejected, 1);
  assert.equal(result.byPhase.user_prompt.records, 1);
  assert.equal(result.byPhase.user_unknown.records, 2);
  assert.equal(result.ioErrors, 0);
});

test('bounded hostile future fields and I/O failures cannot escape through report strings', async () => {
  const canary = 'SYNTHETIC-PRIVATE-HOST';
  const nested = JSON.stringify(entry()).replace('"version":1', '"future":' + '['.repeat(2000) + '"' + canary + '"' + ']'.repeat(2000) + ',"__proto__":{"polluted":"' + canary + '"},"version":1');
  async function* source() { yield Buffer.from(nested + '\n'); throw new Error(canary); }
  const result = await auditStats([source()]);
  assert.equal(result.records.distinct, 1);
  assert.equal(result.ioErrors, 1);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result) + formatText(result), new RegExp(canary));
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});

test('distinct invalid numeric representations are not mistaken for copied records', async () => {
  const first = JSON.stringify(entry({ durationMs: null }));
  async function* source() { yield Buffer.from(first + '\n' + first.replace('"durationMs":null', '"durationMs":1e400')); }
  const result = await auditStats([source()]);
  assert.equal(result.records.distinct, 2);
  assert.equal(result.records.duplicates, 0);
  assert.equal(result.durationExclusions.nonFinite, 1);
  assert.equal(result.durationExclusions.nonNumeric, 1);
});

test('retains empty/missing IDs, checks record limits after duplicates, and renders every group', async () => {
  const missing = entry({ requestId: undefined });
  const empty = entry({ requestId: '' });
  const result = await auditStats([jsonl([entry(), entry(), missing, missing, empty, empty,
    entry({ requestId: 'not-approved', decider: 'user', userChoice: 'manual', verdict: 'rejected' })])]);
  assert.equal(result.records.distinct, 6);
  assert.equal(result.requests.unkeyedRecords, 4);
  assert.equal(result.requests.manualApprovals, 0);
  const bounded = await auditStats([jsonl([entry(), entry()])], { maxRecords: 1 });
  assert.equal(bounded.complete, true);
  assert.equal(bounded.records.duplicates, 1);
  for (const name of ['byPhase', 'byDecider', 'byVerdict', 'byOperation']) assert.match(formatText(result), new RegExp(name + ' \\(duration ms'));
});

test('real file and symlink CLI invocations preserve counting and exit behavior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guardian-cli-'));
  const cli = fileURLToPath(new URL('./audit-stats.ts', import.meta.url));
  try {
    const file = join(directory, 'one.jsonl'), other = join(directory, 'two.jsonl'), link = join(directory, 'stats.ts');
    writeFileSync(file, JSON.stringify(entry()));
    writeFileSync(other, JSON.stringify(entry({ requestId: 'second' })));
    symlinkSync(cli, link);
    for (const target of [cli, link]) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', target, '--json', file, other], { encoding: 'utf8', timeout: 10_000, cwd: process.cwd() });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout).records.distinct, 2);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('parser resource failures make classification explicitly incomplete without losing counts', () => {
  const cli = fileURLToPath(new URL('./audit-stats.ts', import.meta.url));
  const canary = 'SYNTHETIC-PARSER-SECRET';
  const input = [entry({ requestId: 'hostile', actionJson: JSON.stringify({ tool: 'bash', command: ['bash', '-lc', canary + ';' + 'a|'.repeat(12_000)] }) }), entry()];
  const child = spawnSync(process.execPath, ['--import', 'tsx', cli, '--json', '-'], {
    input: input.map(value => JSON.stringify(value)).join('\n'), encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(child.status, 2, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.complete, false);
  assert.equal(result.records.distinct, 2);
  assert.equal(result.classificationExclusions.parserErrors + result.classificationExclusions.scriptLimit, 1);
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(canary));
});
