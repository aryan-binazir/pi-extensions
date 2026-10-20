import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface PermissionConfig {
  enabled: boolean;
  reviewAllShell: boolean;
  rules: unknown[];
  reviewer?: { provider: string; model: string; reasoningEffort: string; prefilter?: boolean };
}
export interface ConfigLoader {
  load(): unknown;
  path: string;
  /** `guardianEnabled` is Guardian's `/guardian on|off` override for this session, when one is set. */
  status(config: unknown, model: ExtensionContext['model'], guardianEnabled?: boolean): string;
}

const GUARDIAN_INDEX = fileURLToPath(new URL('../guardian/index.ts', import.meta.url));
const realpath = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** Guardian, when this package loaded it; otherwise the reviewed Auto Permissions package. */
export async function findConfigLoader(commands: ReturnType<ExtensionAPI['getCommands']>): Promise<ConfigLoader | undefined> {
  const guardian = commands.find(command => command.source === 'extension' && command.name.split(':')[0] === 'guardian'
    && realpath(command.sourceInfo.path) === realpath(GUARDIAN_INDEX));
  if (guardian) {
    const [{ guardianStatusText, loadGuardianConfig }, { guardianConfigPath }, { detectPlatformSandbox }] = await Promise.all([
      import('../guardian/config.ts'), import('../guardian/policies.ts'), import('../guardian/sandbox.ts'),
    ]);
    const sandboxAvailable = (await detectPlatformSandbox()).sandbox !== undefined;
    const path = guardianConfigPath();
    return { path, load: () => loadGuardianConfig(path), status: (config, _model, enabled) => {
      const settings = config as ReturnType<typeof loadGuardianConfig>;
      return guardianStatusText(enabled === undefined ? settings : { ...settings, enabled }, sandboxAvailable);
    } };
  }
  for (const command of commands) {
    if (command.source !== 'extension' || command.name.split(':')[0] !== 'auto-permissions') continue;
    const root = dirname(command.sourceInfo.path);
    let manifest: { name?: string; version?: string };
    try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
    catch { continue; }
    if (manifest.name !== '@hank-warren/pi-auto-permissions') continue;
    if (manifest.version !== '0.16.2' && manifest.version !== '0.21.0') throw new Error('Unsupported Auto Permissions version');
    const helper = await import(join(root, 'config.ts'));
    if (typeof helper.loadAutoPermissionsConfig !== 'function' || typeof helper.autoPermissionsConfigPath !== 'function') throw new Error('Config loader unavailable');
    return { load: helper.loadAutoPermissionsConfig, path: helper.autoPermissionsConfigPath(), status: (config, model) => statusText(config as PermissionConfig, model) };
  }
}

const sanitizeTerminalLabel = (value: string): string => value.replace(/[^a-zA-Z0-9._:/~+-]/g, '?').slice(0, 64);

export function statusText(config: PermissionConfig, model: ExtensionContext['model']): string {
  if (!config.enabled) return 'Auto: off';
  if (!config.reviewAllShell && config.rules.length === 0) return 'Auto: on · no rules';
  const id = config.reviewer?.model ?? model?.id;
  const provider = config.reviewer?.provider ?? model?.provider;
  const name = provider === 'openai-codex' && (id === 'gpt-6-luna' || id === 'gpt-5.6-luna') ? 'Luna' : sanitizeTerminalLabel(id ?? 'no model');
  const effort = sanitizeTerminalLabel(config.reviewer?.reasoningEffort ?? 'low');
  const scope = config.reviewAllShell ? '' : ' · rules only';
  const prefilter = config.reviewer?.prefilter ? ' · prefilter minimal' : '';
  return `Auto: on · ${name} ${effort}${scope}${prefilter}`;
}
