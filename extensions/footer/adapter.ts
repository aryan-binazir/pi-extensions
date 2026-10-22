import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface ConfigLoader {
  load(): unknown;
  path: string;
  /** `guardianEnabled` is Guardian's `/guardian on|off` override for this session, when one is set. */
  status(config: unknown, guardianEnabled?: boolean): string;
}

const GUARDIAN_INDEX = fileURLToPath(new URL('../guardian/index.ts', import.meta.url));
const realpath = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** Guardian, when this package loaded it. */
export async function findConfigLoader(commands: ReturnType<ExtensionAPI['getCommands']>): Promise<ConfigLoader | undefined> {
  const guardian = commands.find(command => command.source === 'extension' && command.name.split(':')[0] === 'guardian'
    && realpath(command.sourceInfo.path) === realpath(GUARDIAN_INDEX));
  if (!guardian) return undefined;
  const [{ guardianStatusText, loadGuardianConfig }, { guardianConfigPath }, { detectPlatformSandbox }] = await Promise.all([
    import('../guardian/config.ts'), import('../guardian/policies.ts'), import('../guardian/sandbox.ts'),
  ]);
  const sandboxAvailable = (await detectPlatformSandbox()).sandbox !== undefined;
  const path = guardianConfigPath();
  return { path, load: () => loadGuardianConfig(path), status: (config, enabled) => {
    const settings = config as ReturnType<typeof loadGuardianConfig>;
    return guardianStatusText(enabled === undefined ? settings : { ...settings, enabled }, sandboxAvailable);
  } };
}
