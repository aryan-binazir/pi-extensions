import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const scenario = JSON.parse(process.env.FAKE_CLAUDE_SCENARIO ?? '{}');
const log = entry => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\n'); };
const idle = () => setInterval(() => {}, 60_000);
const argv = process.argv.slice(2);
log({ pid: process.pid, argv, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(ANTHROPIC_|CLAUDE|DISABLE_AUTOUPDATER)/.test(key))) });
if (argv[0] === '--version') {
  if (scenario.versionFailure) { console.error('synthetic version failure'); process.exit(23); }
  if (scenario.versionHang) {
    process.on('SIGTERM', () => log({ event: 'version-SIGTERM', pid: process.pid }));
    log({ event: 'version-ready', pid: process.pid });
    idle();
    await new Promise(() => {});
  }
  console.log(`${scenario.version ?? '2.1.302'} (Claude Code)`); process.exit(0);
}
const option = name => argv[argv.indexOf(name) + 1];

console.log('fake claude');
if (scenario.exit) { console.log('fatal: fake claude exited'); process.exit(1); }
if (scenario.screen) { console.log(scenario.screen); idle(); }
else await run();

async function run() {
  const settings = JSON.parse(readFileSync(option('--settings'), 'utf8'));
  const sessionId = scenario.sessionId ?? option('--session-id');
  const config = process.env.CLAUDE_CONFIG_DIR, folder = name => name.replace(/[^A-Za-z0-9]/g, '-');
  const transcript = join(config, 'projects', folder(process.cwd()), `${sessionId}.jsonl`);
  const sessions = join(config, 'scratch', folder(process.cwd())), scratchpad = join(sessions, sessionId, 'scratchpad');
  mkdirSync(dirname(transcript), { recursive: true }); writeFileSync(transcript, '{"page":"source"}\n');
  mkdirSync(join(dirname(transcript), sessionId), { recursive: true });
  mkdirSync(scratchpad, { recursive: true });
  const unreportedScratchpad = join(sessions, randomUUID(), 'scratchpad');
  mkdirSync(unreportedScratchpad, { recursive: true });
  if (scenario.foreignScratchpad) mkdirSync(join(config, 'scratch', folder(dirname(process.cwd())), randomUUID(), 'scratchpad'), { recursive: true });
  if (scenario.ignoreHangup) { process.on('SIGHUP', () => {}); setInterval(() => writeFileSync(transcript, '{"page":"source"}\n'), 50); }
  const base = { session_id: sessionId, transcript_path: scenario.transcriptPath ?? transcript, cwd: process.cwd(), scratchpad_dir: scenario.scratchpadDir ?? scratchpad, permission_mode: 'dontAsk' };
  const hook = async (event, body) => {
    const entry = settings.hooks?.[event]?.[0]?.hooks?.[0];
    if (!entry) return { skipped: true };
    try {
      const response = await fetch(entry.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, hook_event_name: event, ...body }) });
      const output = response.ok ? await response.json() : { failed: response.status };
      log({ event, body, output });
      return output;
    } catch (error) { log({ event, body, error: String(error) }); return { failed: String(error) }; }
  };

  const submitted = await hook('UserPromptSubmit', { prompt: argv.at(-1) });
  if (submitted.failed || submitted.decision === 'block') { console.log('prompt blocked'); return idle(); }
  if (scenario.exitAfterPrompt) { console.log('fake claude crashed'); process.exit(1); }
  for (const { event, body } of scenario.events ?? []) await hook(event, body);
  const instruction = submitted.hookSpecificOutput?.additionalContext ?? '';
  const inputs = jsonObjects(instruction);
  const calls = (scenario.calls ?? inputs.map((_, index) => ({ from: index }))).map((call, index) => ({
    tool_name: call.tool ?? 'Artifact', tool_input: { ...(call.from === undefined ? {} : inputs[call.from]), ...call.input, ...call.add }, tool_use_id: `toolu_fake_${index}` }));
  const decisions = scenario.parallel ? await Promise.all(calls.map(call => hook('PreToolUse', call))) : [];
  for (const [index, { tool_name, tool_input, tool_use_id }] of calls.entries()) {
    const decision = decisions[index] ?? await hook('PreToolUse', { tool_name, tool_input, tool_use_id });
    if (decision.continue === false) return idle();
    if (decision.failed || decision.hookSpecificOutput?.permissionDecision !== 'allow') continue;
    if (scenario.stall === tool_input.action) return idle();
    const failure = scenario.failures?.[tool_input.action];
    const response = failure === undefined ? toolResponse(tool_input) : undefined;
    const after = failure === undefined
      ? await hook('PostToolUse', { tool_name, tool_input, tool_use_id, tool_response: response })
      : await hook('PostToolUseFailure', { tool_name, tool_input, tool_use_id, error: failure });
    if (after.continue === false) return idle();
  }
  await hook('Stop', { stop_hook_active: false, last_assistant_message: scenario.lastMessage ?? 'done' });
  idle();
}

function toolResponse(input) {
  const response = structuredClone(scenario.responses?.[input.action] ?? {});
  if (input.action === 'publish' && response.path === undefined) response.path = resolve(input.file_path);
  return response;
}

function jsonObjects(text) {
  const found = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
      const value = parseJson(text.slice(start, end + 1));
      if (value !== undefined) { found.push(value); start = end; break; }
    }
  }
  return found;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}
