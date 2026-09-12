import type { SentinelConfig } from './config.ts';
import type { RootAuthorization } from './evidence.ts';

export interface InheritedSentinel { version: 1; config: SentinelConfig; agentDir: string; policyDigest: string; authorization: RootAuthorization }
export interface ChildGuard { env: Record<string, string>; extensions: string[] }
interface Bridge { prepareChild: () => ChildGuard }
// Symbol.for survives independent extension loader module roots. State remains session-scoped.
const key = Symbol.for('pi-interactive:sentinel-bridge:v1');
const globalState = globalThis as typeof globalThis & { [key]?: Map<string, Bridge> };
const bridges = globalState[key] ??= new Map();
export const bridgeId = (cwd: string, session: string): string => JSON.stringify([cwd, session]);
export function registerGuard(id: string, bridge: Bridge): () => void {
  bridges.set(id, bridge);
  return () => { if (bridges.get(id) === bridge) bridges.delete(id); };
}
export function childGuard(cwd: string, session: string): ChildGuard | undefined {
  return bridges.get(bridgeId(cwd, session))?.prepareChild();
}
