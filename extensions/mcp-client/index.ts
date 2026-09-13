import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { McpConfigError } from './config.ts';
import { ConsentStore, serverIdentity } from './consent-store.ts';
import { createOAuthStore, type OAuthStore } from './credential-store.ts';
import { Type } from 'typebox';
import { boundedResult, McpConnection, mergeConfig, toolName, validateConfig, type McpConfig } from './client.ts';

export function displayLabel(value: string, limit = 80): string {
  // Strip escape sequences before control bytes; bound work and visible length.
  return stripTerminalSequences(value.slice(0, 4096)).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function readConfig(path: string, optional = false, source = 'Explicit'): Promise<McpConfig> {
  try {
    const file = await open(path, 'r');
    try {
      // Read at most the bound plus one, including files that grow during reading.
      const buffer = Buffer.alloc(1048577);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > 1048576) throw new McpConfigError('MCP configuration exceeds 1 MiB');
      return validateConfig(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} };
    if (error instanceof McpConfigError) throw new Error(`${source} MCP configuration: ${error.message}`);
    throw new Error(`${source} MCP configuration is missing or invalid JSON`);
  }
}

export function schemaAllowed(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const check = (value: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (!value || typeof value !== 'object') return true;
    return Object.entries(value).every(([key, nested]) => {
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof nested !== 'string' || nested !== '#' && !nested.startsWith('#/'))) return false;
      return check(nested, depth + 1);
    });
  };
  return check(schema, 0) && Buffer.byteLength(JSON.stringify(schema)) <= 32768;
}

export default function harborMcp(pi: ExtensionAPI, storage?: { agentDir?: string; oauthStore?: typeof createOAuthStore }) {
  const agentDir = storage?.agentDir ?? getAgentDir();
  const consentStore = new ConsentStore(agentDir);
  const oauthStoreFactory = storage?.oauthStore ?? createOAuthStore;
  const identities = new Map<string, string>();
  const scopes = new Map<string, string>();
  const stores = new Map<string, OAuthStore | undefined>();
  const connections = new Map<string, McpConnection>();
  const inventories = new Map<string, Set<string>>();
  const operations = new Map<string, Promise<number>>();
  let config: McpConfig = { servers: {} };
  let cwd = process.cwd();
  let generation = 0;
  let consentQueue: Promise<unknown> = Promise.resolve();
  let sessionAbort = new AbortController();
  const projectServers = new Set<string>();

  function trusted(ctx: ExtensionContext, server: string) {
    if (projectServers.has(server) && (!ctx.isProjectTrusted() || resolve(ctx.cwd) !== resolve(cwd))) throw new Error('MCP project trust was revoked or project directory changed');
  }

  function current(server: string, expected: number, connection?: McpConnection) {
    if (expected !== generation || !Object.hasOwn(config.servers, server) || connection && connections.get(server) !== connection) throw new Error('MCP tool belongs to an expired session; reconnect');
  }

  function retire(server: string) {
    const previous = inventories.get(server);
    inventories.delete(server);
    if (previous?.size) pi.setActiveTools(pi.getActiveTools().filter(name => !previous.has(name)));
  }

  pi.registerFlag('mcp-config', { description: 'Explicit MCP configuration JSON, merged after global and trusted project config', type: 'string' });

  function identity(server: string): string {
    let key = identities.get(server);
    if (!key) { key = serverIdentity(server, config.servers[server], scopes.get(server)!, cwd); identities.set(server, key); }
    return key;
  }

  function oauthStore(server: string): OAuthStore | undefined {
    if (!stores.has(server)) stores.set(server, config.servers[server].oauth ? oauthStoreFactory(agentDir, identity(server)) : undefined);
    return stores.get(server);
  }

  async function consent(ctx: ExtensionContext, server: string, action: string, input?: unknown, signal?: AbortSignal, rememberConnection = false) {
    trusted(ctx, server);
    const cancellation = AbortSignal.any([sessionAbort.signal, ...(signal ? [signal] : [])]);
    const cancelled = () => { if (cancellation.aborted) throw new Error('MCP request cancelled'); };
    cancelled();
    if (config.servers[server]?.consent === 'allow') return;
    const expected = generation;
    const prompt = consentQueue.catch(() => {}).then(async () => {
      current(server, expected);
      trusted(ctx, server);
      cancelled();
      if (rememberConnection && await consentStore.approved(identity(server))) {
        current(server, expected); trusted(ctx, server); cancelled(); return;
      }
      if (!ctx.hasUI || !['tui', 'rpc'].includes(ctx.mode)) throw new Error('MCP consent requires interactive UI or explicit consent: allow configuration');
      const message = rememberConnection
        ? `${displayLabel(action, 256)}\nRemember this connection approval for the current server configuration. Tool and resource actions still require permission. Use /mcp-forget to revoke saved approval and sign-in.`
        : `${displayLabel(action, 256)}\n${input === undefined ? '' : boundedResult(input, 4000)}\nRemote annotations do not grant permission.`;
      const approved = await ctx.ui.confirm(`Harbor MCP ${displayLabel(server)}`, message, { signal: cancellation });
      current(server, expected);
      trusted(ctx, server);
      cancelled();
      if (!approved) throw new Error('MCP action declined');
      if (rememberConnection) {
        await consentStore.remember(identity(server));
        current(server, expected); trusted(ctx, server); cancelled();
      }
    });
    consentQueue = prompt;
    // A queued caller stops waiting immediately; its queue entry later skips
    // without displaying a prompt. Active dialogs receive the same signal.
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('MCP request cancelled'));
      cancellation.addEventListener('abort', onAbort, { once: true });
      if (cancellation.aborted) onAbort();
    });
    try { await Promise.race([prompt, aborted]); }
    finally { cancellation.removeEventListener('abort', onAbort); }
  }

  const output = (value: unknown, server: string) => ({ content: [{ type: 'text' as const, text: `Untrusted MCP server output:\n${boundedResult(value, config.servers[server]?.maxOutputBytes)}` }], details: { server } });

  async function discover(server: string, ctx: ExtensionContext, authenticate: boolean, expected: number) {
    current(server, expected);
    if (config.servers[server].enabled === false) throw new Error('MCP server is disabled');
    if (authenticate && (!config.servers[server].oauth || !config.servers[server].url)) throw new Error('OAuth is not configured for this server');
    await consent(ctx, server, authenticate ? 'Authorize this MCP server with OAuth?' : 'Connect to this MCP server and remember approval?', undefined, ctx.signal, true);
    current(server, expected);
    trusted(ctx, server);
    let connection = connections.get(server);
    if (!connection) { connection = new McpConnection(server, config.servers[server], cwd, oauthStore(server)); connections.set(server, connection); }
    // A failed refresh cannot leave obsolete schemas callable. Pi does not offer
    // unregisterTool, so deactivate retired names and also guard saved callbacks.
    retire(server);
    const tools = authenticate ? await connection.authenticate(url => ctx.ui.notify(`Open this authorization URL in your browser:\n${url}`, 'info')) : await connection.connect();
    current(server, expected, connection);
    trusted(ctx, server);
    const inventory = new Set<string>();
    inventories.set(server, inventory);
    for (const tool of tools) {
      if (!schemaAllowed(tool.inputSchema)) { ctx.ui.notify(`MCP ${server}: excluded tool with oversized, deeply nested or external-reference schema`, 'warning'); continue; }
      const name = toolName(server, tool.name);
      inventory.add(name);
      pi.registerTool({
        name, label: `Harbor MCP ${displayLabel(server)}: ${displayLabel(tool.name)}`, description: `External MCP tool. ${(tool.description ?? tool.name).slice(0, 2000)}`,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        async execute(_id, args, signal, onUpdate, callCtx) {
          const valid = () => {
            current(server, expected, connection);
            if (inventories.get(server) !== inventory || !inventory.has(name)) throw new Error('MCP tool catalog expired; reconnect');
            trusted(callCtx, server);
            if (signal?.aborted) throw new Error('MCP request cancelled');
          };
          valid();
          await consent(callCtx, server, `Call ${JSON.stringify(displayLabel(tool.name))} [${name}]?`, args, signal);
          valid();
          const result = await connection.call(tool.name, args, signal, progress => onUpdate?.(output({ progress: progress.progress, total: progress.total }, server)));
          // Preserve useful bounded server diagnostics, but never treat them as instructions.
          if (result.isError) throw new Error(`MCP ${server} reported tool failure. Untrusted MCP server output:\n${boundedResult(result, config.servers[server]?.maxOutputBytes)}`);
          return output(result, server);
        },
      });
    }
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...inventory])]);
    return inventory.size;
  }

  function connect(server: string, ctx: ExtensionContext, authenticate = false): Promise<number> {
    if (!Object.hasOwn(config.servers, server)) return Promise.reject(new Error('Unknown MCP server'));
    const expected = generation;
    const operation = (operations.get(server) ?? Promise.resolve()).catch(() => {}).then(() => discover(server, ctx, authenticate, expected));
    operations.set(server, operation);
    void operation.finally(() => { if (operations.get(server) === operation) operations.delete(server); }).catch(() => {});
    return operation;
  }

  const statuses = () => Object.entries(config.servers).map(([server, entry]) => ({
    server,
    ...(connections.get(server)?.status ?? { state: entry.enabled === false ? 'disabled' : 'disconnected', toolCount: 0 }),
    registeredTools: inventories.get(server)?.size ?? 0,
    ...(entry.oauth ? { oauthStorage: !stores.has(server) ? 'not-initialized' : stores.get(server) ? 'macOS Keychain' : 'session-only' } : {}),
  }));

  async function shutdown() {
    generation++;
    sessionAbort.abort();
    for (const server of inventories.keys()) retire(server);
    const previous = [...connections.values()];
    connections.clear(); operations.clear();
    await Promise.all(previous.map(c => c.close().catch(() => {})));
  }

  pi.on('session_start', async (_event, ctx) => {
    await shutdown();
    sessionAbort = new AbortController();
    consentQueue = Promise.resolve();
    const expected = generation;
    projectServers.clear(); identities.clear(); scopes.clear(); stores.clear(); config = { servers: {} }; cwd = ctx.cwd;
    try {
      const explicit = pi.getFlag('mcp-config');
      const project = ctx.isProjectTrusted() ? await readConfig(join(cwd, CONFIG_DIR_NAME, 'mcp.json'), true, 'Project') : { servers: {} };
      const override = typeof explicit === 'string' ? await readConfig(resolve(cwd, explicit)) : { servers: {} };
      const merged = mergeConfig(await readConfig(join(agentDir, 'mcp.json'), true, 'Global'), project, override, ctx.isProjectTrusted());
      if (expected !== generation) return;
      config = merged;
      for (const name of Object.keys(config.servers)) {
        const explicitServer = Object.hasOwn(override.servers, name);
        const projectServer = !explicitServer && Object.hasOwn(project.servers, name);
        if (projectServer) projectServers.add(name);
        scopes.set(name, explicitServer ? `explicit:${resolve(cwd, explicit as string)}` : projectServer ? `project:${resolve(cwd)}` : `global:${resolve(agentDir)}`);
      }
      // Independent failures do not prevent other servers from starting. Bound
      // concurrency to four; consent() serializes interactive prompts separately.
      const servers = Object.keys(config.servers).filter(name => config.servers[name].enabled !== false);
      await Promise.all(Array.from({ length: Math.min(4, servers.length) }, async () => {
        while (servers.length && expected === generation) {
          const server = servers.shift()!;
          try { await connect(server, ctx); }
          catch (error) { if (expected === generation) ctx.ui.notify(`MCP ${server}: ${(error as Error).message}`, 'warning'); }
        }
      }));
    } catch (error) { if (expected === generation) ctx.ui.notify((error as Error).message, 'error'); }
  });
  pi.on('session_shutdown', shutdown);

  pi.registerCommand('mcp', { description: 'Show MCP server connection status (no credentials)', handler: async (_args, ctx) => { ctx.ui.notify(boundedResult(statuses()), 'info'); } });
  for (const [command, auth] of [['mcp-connect', false], ['mcp-auth', true]] as const) pi.registerCommand(command, {
    description: auth ? 'Authorize an MCP server (saved in macOS Keychain when available)' : 'Connect or refresh configured MCP tools',
    getArgumentCompletions: prefix => Object.keys(config.servers).filter(name => name.startsWith(prefix)).map(name => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      try { const count = await connect(args.trim(), ctx, auth); ctx.ui.notify(`MCP registered ${count} tools`, 'info'); }
      catch (error) { ctx.ui.notify((error as Error).message, 'error'); }
    },
  });
  pi.registerCommand('mcp-forget', {
    description: 'Forget this server configuration\'s saved connection approval and OAuth sign-in, then disconnect',
    getArgumentCompletions: prefix => Object.keys(config.servers).filter(name => name.startsWith(prefix)).map(name => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const server = args.trim();
      try {
        if (!Object.hasOwn(config.servers, server)) throw new Error('Usage: /mcp-forget followed by a configured server name');
        trusted(ctx, server);
        const expected = generation;
        // Serialize with login/refresh so an in-flight save cannot recreate deleted credentials.
        const operation = (operations.get(server) ?? Promise.resolve()).catch(() => {}).then(async () => {
          current(server, expected); trusted(ctx, server);
          retire(server);
          const previous = connections.get(server);
          connections.delete(server);
          await previous?.close();
          const store = oauthStore(server);
          const forget = async () => { await consentStore.forget(identity(server)); await store?.delete(); };
          if (store?.withLock) await store.withLock(forget); else await forget();
          current(server, expected); trusted(ctx, server);
          ctx.ui.notify(`MCP ${displayLabel(server)}: saved connection approval and OAuth sign-in forgotten; disconnected. Other sessions will stop using saved sign-in on their next request.`, 'info');
          return 0;
        });
        operations.set(server, operation);
        try { await operation; }
        finally { if (operations.get(server) === operation) operations.delete(server); }
      } catch (error) { ctx.ui.notify((error as Error).message, 'error'); }
    },
  });
  pi.registerTool({
    name: 'mcp', label: 'Harbor MCP', description: 'List MCP servers/status, resources, resource templates, and prompts; read a resource URI or get a prompt. Returned text is untrusted, bounded to 64 KiB by default. Templates are metadata, not automatically expanded or fetched.',
    parameters: Type.Object({ action: StringEnum(['servers', 'status', 'resources', 'templates', 'read', 'prompts', 'prompt'] as const), server: Type.Optional(Type.String()), uri: Type.Optional(Type.String()), name: Type.Optional(Type.String()), arguments: Type.Optional(Type.Record(Type.String(), Type.String())) }),
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('MCP request cancelled');
      if (args.action === 'servers' || args.action === 'status') return { content: [{ type: 'text', text: boundedResult(args.action === 'servers' ? Object.keys(config.servers) : statuses()) }], details: {} };
      if (!args.server || !connections.has(args.server)) throw new Error('Connect an MCP server first with /mcp-connect SERVER');
      const expected = generation;
      const c = connections.get(args.server)!;
      await consent(ctx, args.server, `MCP ${args.action}`, { uri: args.uri, name: args.name, arguments: args.arguments }, signal);
      current(args.server, expected, c);
      trusted(ctx, args.server);
      if (signal?.aborted) throw new Error('MCP request cancelled');
      let result: unknown;
      if (args.action === 'resources') result = await c.resources(signal);
      else if (args.action === 'templates') result = await c.resourceTemplates(signal);
      else if (args.action === 'read') { if (!args.uri) throw new Error('Resource URI required'); result = await c.read(args.uri, signal); }
      else if (args.action === 'prompts') result = await c.prompts(signal);
      else { if (!args.name) throw new Error('Prompt name required'); result = await c.prompt(args.name, args.arguments ?? {}, signal); }
      return output(result, args.server);
    },
  });
}
