import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel } from '@earendil-works/pi-ai/compat';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { TaskSpec } from './registry.ts';
import { thinkingLevel, thinkingSuffix } from './thinking.ts';

const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
interface Profile { model: string; thinking: string; description: string; useWhen: string }
export interface ProfileConfig {
  defaultProfile: string;
  profiles: Record<string, Profile>;
  provenance: Record<string, string>;
  sources: string[];
  local: 'trusted' | 'excluded';
  identity: string;
}
export interface SelectionProvenance { config: string; profile: string; model: string; thinking: string }
const astra = 'openai-codex/gpt-6-astra';
const bundledProfiles = {
  defaultProfile: 'implement',
  profiles: {
    research: {model: 'openai-codex/gpt-5.6-luna', thinking: 'medium', description: 'Research', useWhen: 'Gather evidence, compare options, or monitor long-running scripts (e.g. call-*). Report observed progress or failures; silence alone is not a stall. Do not duplicate the built-in subagent tracker.'},
    'implement-small': {model: astra, thinking: 'low', description: 'Settled implementation', useWhen: 'Local change with a settled approach and clear verification.'},
    implement: {model: astra, thinking: 'medium', description: 'General implementation', useWhen: 'Default for implementation work.'},
    'implement-complex': {model: astra, thinking: 'high', description: 'Complex implementation', useWhen: 'Substantial uncertainty or high risk.'},
    review: {model: astra, thinking: 'high', description: 'Review', useWhen: 'Find correctness, security and regression risks.'},
  },
};
function assertObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected an object`);
  return value as Record<string, unknown>;
}
function assertKnownFields(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where}: unknown field ${key}`);
}
function modelSetting(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 240 || (value !== 'inherit' && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:~/-]+$/.test(value))) throw new Error('model must be inherit or provider/model (at most 240 characters)');
}
function readSettings(path: string): unknown | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('expected a regular file');
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    if (length > 65536) throw new Error('settings exceed 64 KiB');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
}
export function loadProfiles(cwd: string, trusted: boolean, agentDir = getAgentDir()): ProfileConfig {
  const profiles: Record<string, Profile> = Object.create(null);
  const provenance: Record<string, string> = Object.create(null);
  let defaultProfile = 'implement';
  const sources: string[] = [];
  const merge = (raw: unknown, source: string) => {
    const value = assertObject(raw, source);
    assertKnownFields(value, ['defaultProfile', 'profiles'], source);
    if (value.defaultProfile !== undefined) {
      if (typeof value.defaultProfile !== 'string' || !namePattern.test(value.defaultProfile)) throw new Error('defaultProfile must be a profile name');
      defaultProfile = value.defaultProfile; provenance.defaultProfile = source;
    }
    if (value.profiles !== undefined) for (const [name, rawProfile] of Object.entries(assertObject(value.profiles, 'profiles'))) {
      if (!namePattern.test(name)) throw new Error(`Invalid profile name: ${name}`);
      const profile = assertObject(rawProfile, `profiles.${name}`);
      assertKnownFields(profile, ['model', 'thinking', 'description', 'useWhen'], `profiles.${name}`);
      for (const [field, entry] of Object.entries(profile)) {
        if (field === 'model') { modelSetting(entry); if (thinkingSuffix.test(entry)) throw new Error(`profiles.${name}: put thinking in thinking, not a model suffix`); }
        else if (field === 'thinking') { if (typeof entry !== 'string' || !(thinkingLevel.test(entry) || entry === 'inherit')) throw new Error(`profiles.${name}: invalid thinking level`); }
        else if (typeof entry !== 'string' || entry.length > 240 || /\p{Cc}/u.test(entry)) throw new Error(`profiles.${name}.${field}: expected single-line text, at most 240 characters`);
        provenance[`${name}.${field}`] = source;
      }
      profiles[name] = {...profiles[name], ...profile} as Profile;
    }
    sources.push(source);
  };
  merge(bundledProfiles, 'bundled');
  for (const path of [join(agentDir, 'subagents.json'), ...(trusted ? [join(cwd, '.pi', 'subagents.local.json')] : [])]) {
    try { const raw = readSettings(path); if (raw !== undefined) merge(raw, path); }
    catch (error) { throw new Error(`Subagent settings ${path}: ${String(error)}. Fix settings and /reload.`); }
  }
  if (Object.keys(profiles).length > 24) throw new Error('Subagent settings: at most 24 profiles; fix settings and /reload');
  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile.model || !profile.thinking) throw new Error(`Subagent profile ${name} requires model and thinking; fix settings and /reload`);
    profile.description ??= ''; profile.useWhen ??= '';
  }
  if (!Object.hasOwn(profiles, defaultProfile)) throw new Error(`Unknown defaultProfile ${defaultProfile}; fix settings and /reload`);
  const config = {defaultProfile, profiles, provenance, sources, local: trusted ? 'trusted' as const : 'excluded' as const};
  return {...config, identity: createHash('sha256').update(JSON.stringify(config)).digest('hex')};
}

function baseModel(model: string): string { return model.replace(/^(openai(?:-codex)?\/.+)~fast$/, '$1'); }
export function availableModel(model: string, registry: ExtensionContext['modelRegistry'], profile?: string) {
  const slash = model.indexOf('/');
  const found = registry?.find(model.slice(0, slash), model.slice(slash + 1));
  if (!found || !registry.getAvailable().some(entry => entry.provider === found.provider && entry.id === found.id)) throw new Error(`Subagent model ${model} is unavailable (profile ${profile ?? 'explicit'}). Configure the exact model in Pi models.json and /login, or change subagents.json; /reload. No fallback selected.`);
  return found;
}
export function resolveProfile(task: TaskSpec, config: ProfileConfig, ctx: Pick<ExtensionContext, 'model' | 'thinkingLevel' | 'modelRegistry'>): TaskSpec {
  if (task.profile !== undefined && (typeof task.profile !== 'string' || !namePattern.test(task.profile))) throw new Error('Invalid subagent profile name');
  if (task.model !== undefined) modelSetting(task.model);
  if (task.thinking !== undefined && (typeof task.thinking !== 'string' || !thinkingLevel.test(task.thinking))) throw new Error('Invalid subagent thinking level');
  const name = task.profile ?? config.defaultProfile;
  if (typeof name !== 'string' || !Object.hasOwn(config.profiles, name)) throw new Error(`Unknown subagent profile ${String(name)}. Choose: ${Object.keys(config.profiles).join(', ')}`);
  const profile = config.profiles[name];
  const selected = task.model ?? profile.model;
  modelSetting(selected);
  const explicitSuffix = task.model?.match(thinkingSuffix)?.[1];
  const inherited = selected === 'inherit';
  const rawModel = inherited ? ctx.model && `${ctx.model.provider}/${ctx.model.id}` : selected.replace(thinkingSuffix, '');
  if (!rawModel) throw new Error('A selected parent model is required for model inherit');
  const model = baseModel(rawModel);
  const found = availableModel(model, ctx.modelRegistry, name);
  let thinking: string | undefined = task.thinking ?? explicitSuffix ?? profile.thinking;
  if (thinking === 'inherit') thinking = ctx.thinkingLevel;
  if (typeof thinking !== 'string' || !thinkingLevel.test(thinking)) throw new Error('Invalid subagent thinking level');
  const effectiveThinking = clampThinkingLevel(found, thinking as ModelThinkingLevel);
  return {...task, profile: name, model: `${found.provider}/${found.id}`, thinking: effectiveThinking, configProvenance: {
    config: config.identity,
    profile: task.profile !== undefined ? 'explicit' : config.provenance.defaultProfile,
    model: (task.model !== undefined ? 'explicit' : config.provenance[`${name}.model`]) + (inherited ? ' (parent model)' : ''),
    thinking: (task.thinking !== undefined ? 'explicit' : explicitSuffix ? 'model suffix' : config.provenance[`${name}.thinking`]) + (task.thinking === undefined && !explicitSuffix && profile.thinking === 'inherit' ? ' (parent thinking)' : '') + (effectiveThinking === thinking ? '' : ` (Pi clamped ${thinking} to ${effectiveThinking})`),
  }};
}
export function profileGuidance(config: ProfileConfig, parent?: Pick<ExtensionContext, 'model' | 'thinkingLevel'>): string {
  const selection = (profile: Profile) => `${profile.model === 'inherit' ? (parent?.model ? baseModel(`${parent.model.provider}/${parent.model.id}`) + ' (inherit)' : 'inherit parent model') : baseModel(profile.model)} / ${profile.thinking === 'inherit' ? `${parent?.thinkingLevel ?? 'parent thinking'} (inherit)` : profile.thinking}`;
  return [
    'Available subagent profiles (subagent and api.spawn):',
    `Default profile (used when profile is omitted): ${config.defaultProfile} (${selection(config.profiles[config.defaultProfile])}).`,
    ...Object.entries(config.profiles).map(([name, profile]) => `${name}: ${selection(profile)} — ${profile.description}${profile.useWhen ? `; ${profile.useWhen}` : ''}`),
  ].join('\n');
}
export function profileLocation(ctx: ExtensionContext, activeCwd: string) {
  const cwd = realpathSync(activeCwd);
  return {cwd, trusted: cwd === realpathSync(ctx.cwd) && ctx.isProjectTrusted?.() === true};
}

export function assertTaskFields(task: object): void {
  assertKnownFields(task as Record<string, unknown>, ['task', 'cwd', 'model', 'thinking', 'profile', 'tools', 'preset', 'extensions', 'timeout'], 'subagent task');
}
