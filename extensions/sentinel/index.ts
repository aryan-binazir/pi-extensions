import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { getActiveCwd } from '../worktree/routing.ts';
import { bridgeId, registerGuard, type InheritedSentinel } from './bridge.ts';
import { digest, loadConfig, loadPreferences, readBounded, type SentinelConfig } from './config.ts';
import { collectEvidence } from './evidence.ts';
import { SentinelEngine, type Verdict } from './engine.ts';
import { classify, review, type ModelRequest } from './transport.ts';

const MODE = 'sentinel:mode';
const MAX_ASYNC_ACTION = 40000;
const MAX_REVIEW_ACTION = 256000;
const inheritedPath = () => process.env.PI_SENTINEL_PARENT;

export default function sentinel(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let instructions = '', steering = '';
  let config: SentinelConfig | undefined;
  let agentDir = getAgentDir();
  let inherited: InheritedSentinel | undefined;
  let engine: SentinelEngine | undefined;
  let unregister: (() => void) | undefined;
  let tempDirectory: string | undefined;
  let failure: string | undefined;
  let generation = 0;
  let reviewedPolicy: string | undefined;
  let enabled = false;
  let incompleteReasons: string[] = [];

  const readParent = async (): Promise<InheritedSentinel | undefined> => {
    const path = inheritedPath();
    if (!path) return;
    const value = JSON.parse(await readBounded(path, 1100000)) as InheritedSentinel;
    if (value.version !== 1 || typeof value.agentDir !== 'string' || !isAbsolute(value.agentDir) || typeof value.policyDigest !== 'string' || !value.config || !value.authorization || typeof value.authorization.instructions !== 'string' || !Array.isArray(value.authorization.users) || typeof value.authorization.complete !== 'boolean') throw new Error('Invalid inherited Sentinel authorization');
    return value;
  };
  const cwd = (ctx: ExtensionContext) => getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId());
  const snapshot = (ctx: ExtensionContext) => collectEvidence(ctx, instructions, inherited?.authorization);
  const publish = () => {
    if (!context || !tempDirectory) return;
    if (!config || failure || !reviewedPolicy) throw new Error(failure ?? 'Sentinel configuration unavailable');
    const authorization = snapshot(context).authorization;
    const serialized = JSON.stringify({ version: 1, config, agentDir, policyDigest: reviewedPolicy, authorization } satisfies InheritedSentinel);
    if (Buffer.byteLength(serialized) > 1100000) throw new Error('Sentinel parent authorization exceeds child budget');
    writeFileSync(join(tempDirectory, 'parent.next'), serialized, { mode: 0o600 });
    renameSync(join(tempDirectory, 'parent.next'), join(tempDirectory, 'parent.json'));
  };
  const publishLifecycle = () => {
    try { publish(); }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      engine?.reset();
      // Nonblocking hooks must not throw. Remove stale authority so existing children fail closed.
      if (tempDirectory) try { rmSync(join(tempDirectory, 'parent.json'), { force: true }); } catch { /* Private snapshot may already be gone. */ }
    }
  };
  const attachBridge = (ctx: ExtensionContext) => {
    unregister?.(); unregister = undefined;
    if (!enabled) return;
    unregister = registerGuard(bridgeId(ctx.cwd, ctx.sessionManager.getSessionId()), {
      prepareChild: () => {
        if (!enabled || !config || failure) throw new Error(failure ?? 'Sentinel not ready');
        tempDirectory ??= mkdtempSync(join(tmpdir(), 'pi-sentinel-'));
        publish();
        return { env: { PI_SENTINEL_PARENT: join(tempDirectory, 'parent.json') }, extensions: [fileURLToPath(import.meta.url)] };
      },
    });
  };
  const initialize = async (ctx: ExtensionContext, expected?: string) => {
    context = ctx;
    const version = ++generation;
    engine?.reset(); engine = undefined;
    failure = enabled ? 'Sentinel is initializing' : undefined;
    attachBridge(ctx);
    if (!enabled) { if (ctx.hasUI) ctx.ui.setStatus('sentinel', 'Sentinel: auto off'); return; }
    try {
      const parent = await readParent();
      const directory = parent?.agentDir ?? getAgentDir();
      const options = await loadConfig(directory);
      if (parent && digest(options) !== digest(parent.config)) throw new Error('Parent Sentinel configuration changed; restart child');
      const preferences = await loadPreferences(options, directory);
      if (expected && expected !== digest({ config: options, preferences })) throw new Error('Sentinel files changed after confirmation; review again');
      const policyDigest = parent?.policyDigest ?? digest(preferences);
      if (policyDigest !== digest(preferences)) throw new Error('Parent has not approved current Sentinel policy');
      if (version !== generation) return;
      inherited = parent; agentDir = directory; config = options; reviewedPolicy = policyDigest;
      engine = new SentinelEngine({
        maxToolCallLag: options.maxToolCallLag, timeoutMs: options.timeoutMs,
        classify: (input, signal) => classify(ctx, options.classifier, input as ModelRequest, signal),
        review: (input, signal) => review(ctx, options.reviewer, input as ModelRequest, signal),
      });
      failure = undefined;
      if (ctx.hasUI) ctx.ui.setStatus('sentinel', 'Sentinel: auto on');
    } catch (error) {
      if (version !== generation) return;
      failure = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Sentinel blocked: ${failure}`, 'error');
      publishLifecycle();
    }
  };
  const restoredMode = (ctx: ExtensionContext) => {
    if (inheritedPath()) return true;
    let on = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === MODE) {
        const data = entry.data as { version?: number; enabled?: unknown } | undefined;
        on = data?.version === 1 && data.enabled === true;
      }
    }
    return on;
  };
  pi.on('session_start', async (_event, ctx) => { enabled = restoredMode(ctx); await initialize(ctx); });
  pi.on('session_tree', async (_event, ctx) => {
    context = ctx;
    try {
      const next = restoredMode(ctx);
      if (enabled !== next) {
        enabled = next;
        // Navigation cannot silently approve files changed since the last confirmation.
        if (enabled) {
          if (!config || !reviewedPolicy) throw new Error('Confirm Sentinel policy with /auto on');
          const preferences = await loadPreferences(config, agentDir);
          if (digest(preferences) !== reviewedPolicy) throw new Error('Sentinel policy changed; run /sentinel reload');
          await initialize(ctx, digest({ config, preferences }));
        } else await initialize(ctx);
      } else engine?.reset();
    } catch (error) {
      engine?.reset(); failure = String(error); attachBridge(ctx);
    }
    publishLifecycle();
  });
  pi.on('session_compact', () => engine?.reset());
  pi.on('input', () => engine?.reset());
  pi.on('before_agent_start', (event, ctx) => {
    context = ctx;
    const options = event.systemPromptOptions;
    const next = JSON.stringify({ customPrompt: options?.customPrompt, appendSystemPrompt: options?.appendSystemPrompt, contextFiles: options?.contextFiles ?? [] });
    const nextSteering = digest({ prompt: event.systemPrompt, options });
    if (next !== instructions || nextSteering !== steering) engine?.reset();
    instructions = next; steering = nextSteering;
    publishLifecycle();
  });
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'questionnaire' || event.isError) return;
    const source = pi.getAllTools().find(tool => tool.name === 'questionnaire')?.sourceInfo.path;
    if (!source || resolve(source) !== fileURLToPath(new URL('../questionnaire/index.ts', import.meta.url))) return;
    const result = event.details as { cancelled?: boolean; answers?: unknown[] } | undefined;
    if (result?.cancelled !== false || !Array.isArray(result.answers)) return;
    pi.appendEntry('sentinel:user-answer', { assistant_authored_questions: event.input, verified_answers: result.answers });
    engine?.reset(); publishLifecycle();
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!enabled) return;
    context = ctx;
    const version = generation;
    try {
      if (!engine || !config || failure) throw new Error(failure ?? 'Sentinel unavailable');
      const currentConfig = await loadConfig(agentDir);
      if (digest(currentConfig) !== digest(config)) { engine.reset(); throw new Error('Sentinel settings changed; run /sentinel reload'); }
      inherited = await readParent();
      if (inherited && digest(inherited.config) !== digest(config)) throw new Error('Parent Sentinel configuration changed; restart child');
      if (inherited && inherited.policyDigest !== reviewedPolicy) { engine.reset(); reviewedPolicy = inherited.policyDigest; }
      const preferences = await loadPreferences(config, agentDir);
      if (digest(preferences) !== reviewedPolicy) { engine.reset(); throw new Error('Sentinel policy changed; run /sentinel reload to confirm the new policy'); }
      const evidence = snapshot(ctx);
      const action = { tool: event.toolName, arguments: structuredClone(event.input), cwd: cwd(ctx) };
      const size = JSON.stringify(action).length;
      if (size > MAX_REVIEW_ACTION) throw new Error('Sentinel action exceeds review budget (256000 characters); split the action');
      incompleteReasons = [...evidence.incompleteReasons, ...(size > MAX_ASYNC_ACTION ? ['async_action_budget'] : [])];
      const identity = digest({ session: ctx.sessionManager.getSessionId(), cwd: action.cwd, authorization: evidence.identity, steering, preferences, config });
      const input: ModelRequest = { identity, action, evidence: evidence.text, images: evidence.images, cwd: action.cwd, systemPrompt: preferences, complete: evidence.complete && size <= MAX_ASYNC_ACTION, asyncEligible: size <= MAX_ASYNC_ACTION };
      // Direct relative paths and custom policy filenames cannot ride a cached score.
      const paths = [config.policyFile, resolve(agentDir, 'sentinel.json')];
      const values = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(values) : value && typeof value === 'object' ? Object.values(value).flatMap(values) : [];
      if (values(action.arguments).some(value => paths.includes(resolve(action.cwd, value)) || paths.some(path => value.includes(path)) || value.includes('sentinel-policy.md') || value.includes('sentinel.json'))) engine.reset();
      publish();
      if (ctx.hasUI) ctx.ui.setStatus('sentinel', `Sentinel: checking ${event.toolName}`);
      const verdict = await engine.decide(input, ctx.signal);
      ctx.signal?.throwIfAborted();
      if (!enabled || version !== generation) throw new Error('Sentinel session changed during review');
      const latestParent = await readParent();
      const latestEvidence = collectEvidence(ctx, instructions, latestParent?.authorization);
      if (latestEvidence.identity !== evidence.identity || (latestParent && latestParent.policyDigest !== reviewedPolicy) || cwd(ctx) !== action.cwd || digest(await loadPreferences(config, agentDir)) !== reviewedPolicy || digest(await loadConfig(agentDir)) !== digest(config)) {
        engine.reset(); throw new Error('Sentinel authorization, policy, settings, or worktree changed during review; retry');
      }
      record(verdict, event.toolName, ctx);
      if (!verdict.allow) return { block: true, reason: `Sentinel: ${verdict.assessment?.rationale ?? verdict.reason}. Do not bypass this denial; obtain specific user authorization or use a safer action.` };
    } catch (error) {
      engine?.reset();
      const reason = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.setStatus('sentinel', 'Sentinel: blocked');
      return { block: true, reason: `Sentinel failed closed: ${reason}` };
    }
  });
  function record(verdict: Verdict, tool: string, ctx: ExtensionContext) {
    pi.appendEntry('sentinel:decision', { version: 1, tool, allow: verdict.allow, source: verdict.source, reason: verdict.reason.slice(0, 2000) });
    if (ctx.hasUI) ctx.ui.setStatus('sentinel', `Sentinel: ${verdict.allow ? verdict.source : 'denied'}`);
  }
  const command = async (args: string, ctx: ExtensionCommandContext) => {
    const action = args.trim();
    if (!['', 'status', 'on', 'off', 'reload'].includes(action)) { ctx.ui.notify('Usage: /auto [on|off|status] or /sentinel [reload]', 'warning'); return; }
    if (action === '' || action === 'status') {
      ctx.ui.notify(JSON.stringify({ enabled, state: enabled ? failure ?? 'active' : 'off', config, incompleteReasons, ...engine?.status() }, null, 2), enabled && failure ? 'error' : 'info'); return;
    }
    if (!ctx.isIdle() || !ctx.hasUI || inheritedPath()) { ctx.ui.notify('Sentinel mode/policy changes require an idle interactive parent session', 'warning'); return; }
    if (action === 'off') {
      enabled = false; ++generation; engine?.reset(); engine = undefined; failure = undefined;
      unregister?.(); unregister = undefined;
      pi.appendEntry(MODE, { version: 1, enabled: false });
      ctx.ui.setStatus('sentinel', 'Sentinel: auto off');
      ctx.ui.notify('Auto review is off. Already-running guarded children remain guarded until they finish.', 'info'); return;
    }
    try {
      const next = await loadConfig(agentDir);
      const preferences = await loadPreferences(next, agentDir);
      const shown = `Settings:\n${JSON.stringify(next, null, 2)}\n\nStanding preferences:\n${preferences || '(none)'}`;
      const submitted = await ctx.ui.editor('Review Sentinel settings and policy; submit unchanged to confirm', shown);
      if (submitted !== shown || !await ctx.ui.confirm('Enable auto review with this policy?', 'These preferences will authorize or restrict actions in this session and its children.')) return;
      const expected = digest({ config: next, preferences });
      enabled = true;
      await initialize(ctx, expected);
      pi.appendEntry(MODE, { version: 1, enabled: true });
      publishLifecycle();
    } catch (error) { ctx.ui.notify(String(error), 'error'); }
  };
  pi.registerCommand('sentinel', { description: 'Auto review status, on/off, or confirmed policy reload', handler: command });
  pi.registerCommand('auto', { description: 'Session auto review (new chats default off): /auto [on|off|status]', handler: command });
  pi.on('session_shutdown', async () => {
    ++generation; engine?.reset(); engine = undefined; failure = 'Sentinel session stopped';
    unregister?.(); unregister = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });
}
