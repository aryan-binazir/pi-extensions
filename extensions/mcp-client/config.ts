import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

// Harbor MCP configuration. Third-party notices: docs/licenses/.
export interface ServerConfig {
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; transport?: 'stdio' | 'http' | 'sse';
  headers?: Record<string, string>; oauth?: { clientId?: string; scope?: string };
  allowTools?: string[]; denyTools?: string[];
  consent?: 'ask' | 'allow'; timeoutMs?: number; maxOutputBytes?: number;
  enabled?: boolean; cwd?: string; envVars?: string[];
  envHeaders?: Record<string, string>; bearerTokenEnvVar?: string;
  startupTimeoutMs?: number; toolTimeoutMs?: number;
}
export interface McpConfig { servers: Record<string, ServerConfig> }
const aliases: Record<string, string> = {
  startup_timeout_sec: 'startupTimeoutMs', tool_timeout_sec: 'toolTimeoutMs',
  enabled_tools: 'allowTools', disabled_tools: 'denyTools', env_vars: 'envVars',
  http_headers: 'headers', env_http_headers: 'envHeaders', bearer_token_env_var: 'bearerTokenEnvVar',
};
const fields = new Set('command args env url transport headers oauth allowTools denyTools consent timeoutMs maxOutputBytes enabled cwd envVars envHeaders bearerTokenEnvVar startupTimeoutMs toolTimeoutMs'.split(' '));
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
export class McpConfigError extends Error {}
function fail(message = 'Invalid MCP configuration'): never { throw new McpConfigError(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) fail();
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || nonempty && !value.trim()) fail();
  return value;
}
function variable(value: unknown): string {
  const name = string(value);
  if (!identifier.test(name)) fail('Invalid MCP environment identifier');
  return name;
}
function stringMap(value: unknown, envKeys = false, envValues = false): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [envKeys ? variable(key) : key, envValues ? variable(item) : string(item)]));
}
function serverConfig(value: unknown): ServerConfig {
  const input = record(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    const canonical = Object.hasOwn(aliases, key) ? aliases[key] : key;
    if (!fields.has(canonical)) fail('Unsupported MCP server field or policy');
    if (canonical !== key && Object.hasOwn(input, canonical)) fail('Conflicting MCP configuration fields');
    let normalized: unknown = value;
    if (key === 'startup_timeout_sec' || key === 'tool_timeout_sec') {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail();
      const milliseconds = value * 1000;
      const rounded = Math.round(milliseconds);
      if (Math.abs(milliseconds - rounded) > Number.EPSILON * Math.max(1, Math.abs(milliseconds))) fail('MCP timeout requires integer milliseconds');
      normalized = rounded;
    }
    out[canonical] = normalized;
  }
  for (const [key, value] of Object.entries(out)) {
    if (['command', 'url', 'cwd'].includes(key)) out[key] = string(value, true);
    else if (['args', 'allowTools', 'denyTools', 'envVars'].includes(key)) {
      if (!Array.isArray(value) || value.length > 256) fail('Invalid MCP string list');
      out[key] = Array.from(value, item => key === 'envVars' ? variable(item) : string(item));
    } else if (['env', 'headers', 'envHeaders'].includes(key)) out[key] = stringMap(value, key === 'env', key === 'envHeaders');
    else if (key === 'bearerTokenEnvVar') out[key] = variable(value);
    else if (key === 'oauth') {
      const oauth = record(value);
      if (Object.keys(oauth).some(k => !['clientId', 'scope'].includes(k))) fail('Unsupported MCP OAuth field');
      out[key] = Object.fromEntries(Object.entries(oauth).map(([k, v]) => [k, string(v)]));
    } else if (key === 'enabled') { if (typeof value !== 'boolean') fail(); }
    else if (key === 'transport') { if (!['stdio', 'http', 'sse'].includes(string(value))) fail(); }
    else if (key === 'consent') { if (!['ask', 'allow'].includes(string(value))) fail(); }
    else {
      const min = key === 'maxOutputBytes' ? 256 : 10;
      const max = key === 'maxOutputBytes' ? 1048576 : 120000;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail('MCP limit outside supported range');
    }
  }
  const has = (key: string) => Object.hasOwn(out, key);
  if (has('command') === has('url')) fail('MCP server requires exactly one command or URL');
  if (has('command')) {
    if (has('transport') && out.transport !== 'stdio' || ['headers', 'envHeaders', 'bearerTokenEnvVar', 'oauth'].some(has)) fail('Invalid MCP stdio config');
  } else {
    if (out.transport === 'stdio' || ['args', 'env', 'envVars', 'cwd'].some(has)) fail('Invalid MCP HTTP config');
    try {
      const url = new URL(out.url as string);
      if (url.username || url.password || (out.url as string).includes('#') || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail();
    } catch { fail('MCP requires HTTPS or loopback HTTP without credentials or fragments'); }
  }
  if (has('oauth') && has('bearerTokenEnvVar')) fail('Ambiguous MCP authentication configuration');
  return { ...out } as ServerConfig;
}
export function validateConfig(value: unknown): McpConfig {
  const root = record(value);
  const keys = Object.keys(root);
  if (keys.length !== 1 || !['servers', 'mcp_servers'].includes(keys[0])) fail('MCP config requires exactly one supported servers object');
  const entries = Object.entries(record(root[keys[0]]));
  if (entries.length > 32) fail('MCP server limit is 32');
  return { servers: Object.fromEntries(entries.map(([name, value]) => {
    if (!name || name.length > 128) fail('Invalid MCP server entry');
    return [name, serverConfig(value)];
  })) };
}
export function mergeConfig(global: McpConfig, project: McpConfig, explicit: McpConfig, trusted: boolean): McpConfig {
  return validateConfig({ servers: { ...validateConfig(global).servers, ...(trusted ? validateConfig(project).servers : {}), ...validateConfig(explicit).servers } });
}
function environmentValue(name: string): string {
  const value = process.env[variable(name)];
  if (value === undefined) fail('MCP environment reference unavailable');
  return value;
}
function interpolate(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => environmentValue(name));
}
export function resolveEnvironment(config: ServerConfig): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(getDefaultEnvironment()),
    ...(config.envVars ?? []).map(name => [name, environmentValue(name)] as const),
    ...Object.entries(config.env ?? {}).map(([name, value]) => [variable(name), interpolate(value)] as const),
  ]);
}
export function resolveHeaders(config: ServerConfig): Headers {
  if (config.bearerTokenEnvVar !== undefined && config.oauth !== undefined) fail('Ambiguous MCP authentication configuration');
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, interpolate(value));
    for (const [key, name] of Object.entries(config.envHeaders ?? {})) headers.set(key, environmentValue(name));
    if (config.bearerTokenEnvVar !== undefined) headers.set('Authorization', `Bearer ${environmentValue(config.bearerTokenEnvVar)}`);
    return headers;
  } catch { fail('MCP headers could not be resolved'); }
}
export function requestTimeout(config: ServerConfig): number { return config.toolTimeoutMs ?? config.timeoutMs ?? 60000; }
export function startupTimeout(config: ServerConfig): number { return config.startupTimeoutMs ?? config.timeoutMs ?? 10000; }
