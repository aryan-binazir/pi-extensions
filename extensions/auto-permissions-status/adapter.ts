import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface PermissionConfig {
  enabled: boolean;
  reviewAllShell: boolean;
  rules: unknown[];
  reviewer?: { provider: string; model: string; reasoningEffort: string; prefilter: boolean };
}
export type ConfigLoader = () => PermissionConfig;

export async function findConfigLoader(commands: ReturnType<ExtensionAPI['getCommands']>): Promise<ConfigLoader | undefined> {
  for (const command of commands) {
    if (command.source !== 'extension' || command.name.split(':')[0] !== 'auto-permissions') continue;
    const root = dirname(command.sourceInfo.path);
    let manifest: { name?: string; version?: string };
    try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
    catch { continue; }
    if (manifest.name !== '@hank-warren/pi-auto-permissions') continue;
    if (manifest.version !== '0.16.2') throw new Error('Unsupported Auto Permissions version');
    const helper = await import(join(root, 'config.ts'));
    if (typeof helper.loadAutoPermissionsConfig !== 'function') throw new Error('Config loader unavailable');
    return helper.loadAutoPermissionsConfig as ConfigLoader;
  }
}

const sanitizeTerminalLabel = (value: string): string => value.replace(/[^a-zA-Z0-9._:/~+-]/g, '?').slice(0, 64);

export function statusText(config: PermissionConfig, model: ExtensionContext['model']): string {
  if (!config.enabled) return 'Auto: off';
  if (!config.reviewAllShell && config.rules.length === 0) return 'Auto: on · no rules';
  const id = config.reviewer?.model ?? model?.id;
  const provider = config.reviewer?.provider ?? model?.provider;
  const name = provider === 'openai-codex' && id === 'gpt-5.6-luna' ? 'Luna' : sanitizeTerminalLabel(id ?? 'no model');
  const effort = sanitizeTerminalLabel(config.reviewer?.reasoningEffort ?? 'low');
  const scope = config.reviewAllShell ? '' : ' · rules only';
  const prefilter = config.reviewer?.prefilter ? ' · prefilter minimal' : '';
  return `Auto: on · ${name} ${effort}${scope}${prefilter}`;
}
