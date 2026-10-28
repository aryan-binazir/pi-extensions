import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadShell, type Shell } from './shell.ts';

const DECIDERS = ['auto_review', 'user', 'policy', 'unknown'] as const;
const VERDICTS = ['approved', 'rejected', 'aborted', 'error', 'unknown'] as const;
const OPERATIONS = ['git', 'package', 'node', 'network', 'filesystem', 'file_write', 'file_edit', 'compound', 'unknown'] as const;
const PHASES = ['auto_review', 'user_prompt', 'user_unknown', 'manual_approval', 'policy', 'unknown'] as const;
type Decider = typeof DECIDERS[number];
type Verdict = typeof VERDICTS[number];
type Operation = typeof OPERATIONS[number];
type Samples = { records: number; values: number[]; excluded: number };
const DEFAULT_LIMITS = { maxLineBytes: 1024 * 1024, maxInputBytes: 64 * 1024 * 1024, maxRecords: 100_000, maxInputs: 128, maxScriptBytes: 32 * 1024 };

function fingerprint(data: Record<string, unknown>): string {
  const hash = createHash('sha256');
  const stack: ({ value: unknown } | { token: string })[] = [{ value: data }];
  while (stack.length) {
    const item = stack.pop()!;
    if ('token' in item) { hash.update(item.token); continue; }
    const value = item.value;
    if (Array.isArray(value)) {
      hash.update('[');
      stack.push({ token: ']' });
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i] }, { token: ',' });
    } else if (object(value)) {
      const record = value as Record<string, unknown>;
      hash.update('{');
      stack.push({ token: '}' });
      for (const key of Object.keys(record).sort().reverse()) {
        stack.push({ value: record[key] }, { token: ':' }, { token: JSON.stringify(key) }, { token: ',' });
      }
    } else hash.update(typeof value + ':' + (typeof value === 'number' ? String(value) : JSON.stringify(value)));
  }
  return hash.digest('hex');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function groups<K extends string>(keys: readonly K[]): Record<K, Samples> {
  return Object.fromEntries(keys.map(key => [key, { records: 0, values: [] as number[], excluded: 0 }])) as Record<K, Samples>;
}

function timing(samples: Samples) {
  const values = samples.values.sort((a, b) => a - b);
  const percentile = (p: number) => values.length ? values[Math.ceil(p * values.length / 100) - 1] : null;
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return { count: values.length, excluded: samples.excluded, total: total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString(),
    p50: percentile(50), p90: percentile(90), p95: percentile(95) };
}

function summarize<K extends string>(values: Record<K, Samples>) {
  return Object.fromEntries(Object.entries<Samples>(values).map(([key, value]) => [key, { records: value.records, durationMs: timing(value) }])) as Record<K, { records: number; durationMs: ReturnType<typeof timing> }>;
}

function operation(data: Record<string, unknown>, shell: Shell | undefined, maxScriptBytes: number): Operation | 'parserErrors' | 'parserUnavailable' | 'scriptLimit' {
  if (data.actionTruncated === true || typeof data.actionJson !== 'string') return 'unknown';
  let action: Record<string, unknown> | undefined;
  try { action = object(JSON.parse(data.actionJson)); } catch { return 'unknown'; }
  if (action?.tool === 'write') return 'file_write';
  if (action?.tool === 'edit') return 'file_edit';
  if (action?.tool !== 'bash' || !Array.isArray(action.command) || !action.command.every(word => typeof word === 'string')) return 'unknown';
  if (!shell) return 'parserUnavailable';
  const extracted = shell.extractBashCommand(action.command);
  if (!extracted) return 'unknown';
  if (Buffer.byteLength(extracted[1]) > maxScriptBytes) return 'scriptLimit';
  let commands: string[][] | undefined;
  try { commands = shell.parseShellScriptIntoCommands(extracted[1]); } catch { return 'parserErrors'; }
  if (!commands?.length) return 'unknown';
  if (commands.length > 1) return 'compound';
  const executable = commands[0][0];
  if (executable === 'git') return 'git';
  if (['npm', 'pnpm', 'yarn', 'npx'].includes(executable)) return 'package';
  if (['node', 'tsx'].includes(executable)) return 'node';
  if (['curl', 'wget', 'gh', 'ssh'].includes(executable)) return 'network';
  if (['rm', 'mv', 'cp', 'mkdir', 'chmod', 'ln', 'touch'].includes(executable)) return 'filesystem';
  return 'unknown';
}

export async function auditStats(inputs: Iterable<AsyncIterable<Uint8Array>>, options: Partial<typeof DEFAULT_LIMITS> = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw new Error('Invalid limits');
  }
  const shell = await loadShell();
  const all: Samples = { records: 0, values: [], excluded: 0 };
  const byDecider = groups(DECIDERS), byVerdict = groups(VERDICTS), byOperation = groups(OPERATIONS);
  const byPhase = groups(PHASES);
  const decisions = Object.fromEntries(DECIDERS.map(decider => [decider, Object.fromEntries(VERDICTS.map(verdict => [verdict, 0]))])) as Record<Decider, Record<Verdict, number>>;
  const requests = new Map<string, { decisions: number; outcomes: Set<Verdict>; automatic: boolean; promptUser: boolean; manual: boolean }>();
  const seen = new Set<string>();
  let duplicates = 0, unkeyedRecords = 0;
  let truncatedActions = 0;
  const input = { sources: 0, bytes: 0, lines: 0, blankLines: 0, nonAuditLines: 0 };
  const exclusions = { malformedJsonLines: 0, invalidUtf8Lines: 0, oversizedLines: 0, invalidAuditData: 0, unsupportedVersion: 0 };
  const durationExclusions = { missing: 0, nonNumeric: 0, nonFinite: 0, negative: 0, notSafeInteger: 0 };
  const classificationExclusions = { parserErrors: 0, parserUnavailable: 0, scriptLimit: 0 };
  let parserFailed = false;
  let stoppedBy: 'input_bytes' | 'records' | 'inputs' | null = null;
  let ioErrors = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const consume = (bytes: Uint8Array, oversized: boolean) => {
    input.lines++;
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, bytes.length - 1);
    if (oversized || bytes.length > limits.maxLineBytes) { exclusions.oversizedLines++; return; }
    let line: string;
    try { line = decoder.decode(bytes); } catch { exclusions.invalidUtf8Lines++; return; }
    if (!line.trim()) { input.blankLines++; return; }
    let value: Record<string, unknown> | undefined;
    try { value = object(JSON.parse(line)); } catch { exclusions.malformedJsonLines++; return; }
    if (value?.type !== 'custom' || value.customType !== 'guardian-approval-decision') { input.nonAuditLines++; return; }
    const data = object(value.data);
    if (!data) { exclusions.invalidAuditData++; return; }
    if (data.version !== 1) { exclusions.unsupportedVersion++; return; }
    const requestId = typeof data.requestId === 'string' && data.requestId ? data.requestId : undefined;
    let key: string | undefined;
    if (requestId) {
      key = fingerprint(data);
      if (seen.has(key)) { duplicates++; return; }
    }
    if (all.records >= limits.maxRecords) { stoppedBy = 'records'; return; }
    if (key) seen.add(key);
    if (data.actionTruncated === true) truncatedActions++;
    const decider: Decider = DECIDERS.find(key => key === data.decider) ?? 'unknown';
    const verdict: Verdict = VERDICTS.find(key => key === data.verdict) ?? 'unknown';
    const phase = decider === 'user' ? data.userChoice === 'manual' ? 'manual_approval'
      : typeof data.userChoice === 'string' && ['approve', 'approve_and_persist', 'reject', 'dismiss'].includes(data.userChoice) ? 'user_prompt' : 'user_unknown' : decider;
    decisions[decider][verdict]++;
    const duration = data.durationMs;
    const invalid = duration === undefined ? 'missing' : typeof duration !== 'number' ? 'nonNumeric'
      : !Number.isFinite(duration) ? 'nonFinite' : duration < 0 ? 'negative' : !Number.isSafeInteger(duration) ? 'notSafeInteger' : undefined;
    if (invalid) durationExclusions[invalid]++;
    const classified = operation(data, parserFailed ? undefined : shell, limits.maxScriptBytes);
    let category: Operation;
    if (classified === 'parserErrors' || classified === 'parserUnavailable' || classified === 'scriptLimit') {
      classificationExclusions[classified]++;
      parserFailed ||= classified === 'parserErrors';
      category = 'unknown';
    } else category = classified;
    for (const group of [all, byDecider[decider], byVerdict[verdict], byOperation[category], byPhase[phase]]) {
      group.records++;
      if (!invalid) group.values.push(duration as number);
      else group.excluded++;
    }
    if (requestId) {
      const request = requests.get(requestId) ?? { decisions: 0, outcomes: new Set<Verdict>(), automatic: false, promptUser: false, manual: false };
      request.decisions++;
      request.outcomes.add(verdict);
      request.automatic ||= decider === 'auto_review';
      request.promptUser ||= phase === 'user_prompt';
      request.manual ||= phase === 'manual_approval' && verdict === 'approved';
      requests.set(requestId, request);
    } else unkeyedRecords++;
  };
  sources: for (const source of inputs) {
    if (input.sources >= limits.maxInputs) { stoppedBy = 'inputs'; break; }
    input.sources++;
    const line = Buffer.alloc(limits.maxLineBytes + 1);
    let length = 0, oversized = false;
    try {
      for await (const chunk of source) {
        const admitted = Math.min(chunk.byteLength, limits.maxInputBytes - input.bytes);
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, admitted);
        input.bytes += admitted;
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset);
          const end = newline === -1 ? bytes.length : newline;
          const size = end - offset;
          if (!oversized && length + size <= line.length) {
            bytes.copy(line, length, offset, end);
            length += size;
          } else { oversized = true; length = 0; }
          if (newline !== -1) {
            consume(line.subarray(0, length), oversized);
            length = 0; oversized = false;
            if (stoppedBy) break sources;
          }
          offset = end + 1;
        }
        if (admitted < chunk.byteLength) { stoppedBy = 'input_bytes'; break sources; }
      }
      if (length || oversized) consume(line.subarray(0, length), oversized);
      if (stoppedBy) break;
    } catch { ioErrors++; }
  }
  const keyed = [...requests.values()];
  return { complete: !stoppedBy && !ioErrors && [...Object.values(exclusions), ...Object.values(classificationExclusions)].every(count => count === 0), stoppedBy, limits, input, exclusions, durationExclusions, classificationExclusions, ioErrors, truncatedActions, decisions,
    records: { audit: all.records + duplicates + exclusions.invalidAuditData + exclusions.unsupportedVersion, distinct: all.records, duplicates },
    requests: { unique: requests.size, unkeyedRecords,
      withMultipleDecisions: keyed.filter(request => request.decisions > 1).length,
      additionalDecisions: keyed.reduce((sum, request) => sum + request.decisions - 1, 0),
      autoAndPromptUser: keyed.filter(request => request.automatic && request.promptUser).length,
      manualApprovals: keyed.filter(request => request.manual).length,
      outcomes: Object.fromEntries(VERDICTS.map(verdict => [verdict, keyed.filter(request => request.outcomes.has(verdict)).length])) },
    durationMs: timing(all), byDecider: summarize(byDecider), byPhase: summarize(byPhase), byVerdict: summarize(byVerdict), byOperation: summarize(byOperation),
    method: [
      'Only version 1 guardian-approval-decision custom entries are aggregated; future extra fields are ignored in output.',
      'Audit records include duplicates and excluded schemas within the retained scan prefix. Distinct decisions exclude copied metadata with a nonempty requestId (SHA-256 of canonical data). Unkeyed records are never deduplicated.',
      'Unique requests use nonempty recorded requestId. Outcome flags overlap and are independent of input order. Additional decisions are distinct records beyond the first per request.',
      'Timing samples are nonnegative safe integer milliseconds. Percentiles use exact nearest-rank ceil(p*n/100); empty percentiles are null. Totals above the safe integer range are decimal strings.',
      'Timings and breakdowns exclude duplicates and invalid durations. All-decider and operation timings mix phases; use byPhase.auto_review for review latency and byPhase.user_prompt for prompt handling.',
      'Manual approvals measure immediate command handling and are isolated in byPhase.manual_approval. Total recorded duration is a sum of handling intervals, not wall-clock elapsed time.',
      'User decisions with missing or unfamiliar userChoice are isolated in byPhase.user_unknown; their prompt or manual origin cannot be established.',
      'Operation classes use the recorded action tool and existing literal shell parser. Multiple plain commands are compound; unsupported syntax, wrappers, paths and truncated actions are unknown. No commands are executed.',
      'All byOperation record counts and timings refer to distinct decisions, not requests. A fallback or manual approval can contribute another decision to the same class.',
      'Scripts above maxScriptBytes are not parsed. A parser throw disables further shell parsing for this scan. Classification exclusions mark the report incomplete but preserve decision counts and timings.',
      'Input bytes count admitted chunks, including bytes following the last processed record within a chunk. Resource limits stop the scan; malformed, oversized and unsupported records are counted and excluded.',
    ],
    limitations: [
      'Requests are not executed commands. Audit records do not prove execution, success, escalation cause, permission safety or time saved.',
      'Runtime retries are not observable. Repeated decisions can be fallback or manual approval; matching actions across different requests are not treated as retries.',
      'No session discovery, date filtering or conversation-branch selection is performed. Explicit inputs may contain copied or abandoned branches; canonical metadata deduplication cannot identify changed copies.',
      'Missing request IDs are counted only as unkeyed decisions. Unknown deciders and verdicts use fixed unknown buckets; unsupported versions are excluded.',
      'Only recorded decisions and durations are available; pre-approval refusals, unsaved decisions, sessions without persistence and unrecorded retry work are absent. Small samples limit percentile interpretation.',
    ] };
}

export function formatText(report: Awaited<ReturnType<typeof auditStats>>): string {
  const lines = [
    `Complete: ${report.complete}; stopped by: ${report.stoppedBy ?? 'none'}`,
    `Audit records: ${report.records.audit}; duplicates: ${report.records.duplicates}`,
    `Distinct decisions: ${report.records.distinct}`,
    `Unique requests: ${report.requests.unique}; unkeyed decisions: ${report.requests.unkeyedRecords}`,
    `Requests with multiple decisions: ${report.requests.withMultipleDecisions}; additional decisions: ${report.requests.additionalDecisions}`,
    `Requests with automatic and prompt-user decisions: ${report.requests.autoAndPromptUser}; manual approvals: ${report.requests.manualApprovals}`,
    `Request outcome flags (overlap): ${JSON.stringify(report.requests.outcomes)}`,
    `Decisions by decider and verdict: ${JSON.stringify(report.decisions)}`,
  ];
  for (const [name, groups] of Object.entries({ byPhase: report.byPhase, byDecider: report.byDecider, byVerdict: report.byVerdict, byOperation: report.byOperation })) {
    lines.push(name + ' (duration ms: total; p50/p90/p95; n; excluded):');
    for (const [key, group] of Object.entries(groups)) {
      const time = group.durationMs;
      lines.push(`  ${key}: records=${group.records}; ${time.total}; ${time.p50 ?? 'null'}/${time.p90 ?? 'null'}/${time.p95 ?? 'null'}; n=${time.count}; excluded=${time.excluded}`);
    }
  }
  lines.push(`Input: ${JSON.stringify(report.input)}`, `Limits: ${JSON.stringify(report.limits)}`,
    `Exclusions: ${JSON.stringify(report.exclusions)}`, `Invalid durations: ${JSON.stringify(report.durationExclusions)}`,
    `Classification exclusions: ${JSON.stringify(report.classificationExclusions)}`,
    `I/O errors: ${report.ioErrors}; truncated actions: ${report.truncatedActions}`, 'Method:', ...report.method, 'Limitations:', ...report.limitations);
  return lines.join('\n');
}

async function main(args: string[]): Promise<void> {
  const usage = 'Usage: node --import tsx extensions/guardian/audit-stats.ts [--json] [--] FILE...\nUse - once for stdin. No files are discovered automatically.';
  const paths: string[] = [];
  let json = false, positional = false;
  for (const arg of args) {
    if (!positional && arg === '--help') { console.log(usage); return; }
    if (!positional && arg === '--json') json = true;
    else if (!positional && arg === '--') positional = true;
    else if (!positional && arg.startsWith('-') && arg !== '-') { console.error(usage); process.exitCode = 1; return; }
    else paths.push(arg);
  }
  if (!paths.length || paths.length > DEFAULT_LIMITS.maxInputs || paths.filter(path => path === '-').length > 1) {
    console.error(usage); process.exitCode = 1; return;
  }
  async function* file(path: string) { yield* createReadStream(path, { highWaterMark: 64 * 1024 }); }
  const report = await auditStats(paths.map(path => path === '-' ? process.stdin : file(path)));
  console.log(json ? JSON.stringify(report, null, 2) : formatText(report));
  if (report.ioErrors) { console.error('Could not read an input.'); process.exitCode = 1; }
  else if (!report.complete) process.exitCode = 2;
}

let mainModule = false;
try { mainModule = Boolean(process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)); } catch { mainModule = false; }
if (mainModule) {
  process.stdout.on('error', () => { process.exitCode = 1; });
  process.stderr.on('error', () => { process.exitCode = 1; });
  void main(process.argv.slice(2)).catch(() => { console.error('Audit statistics failed.'); process.exitCode = 1; });
}
