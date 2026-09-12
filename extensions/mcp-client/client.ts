import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, type Progress, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SessionOAuth } from './oauth.ts';
import { McpConfigError, validateConfig, resolveEnvironment, resolveHeaders, requestTimeout, startupTimeout, type ServerConfig } from './config.ts';
import { collectPages, McpLimitError, withDeadline } from './pagination.ts';
export { mergeConfig, validateConfig, type McpConfig, type ServerConfig } from './config.ts';

export function toolName(server: string, name: string) {
  const hash = createHash('sha256').update(JSON.stringify([server, name])).digest('hex').slice(0, 16);
  return `mcp_${server.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16)}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}_${hash}`;
}

class McpPublicError extends Error {
  constructor(readonly kind: 'cancelled' | 'timeout' | 'auth_required' | 'denied' | 'failure', message: string) { super(message); }
}
export function publicError(error: unknown): Error {
  if (error instanceof McpPublicError || error instanceof McpLimitError || error instanceof McpConfigError) return error;
  const e = error as { name?: string; code?: number; status?: number };
  if (e?.name === 'AbortError') return new McpPublicError('cancelled', 'MCP request cancelled');
  if (e?.code === -32001 || e?.name === 'TimeoutError') return new McpPublicError('timeout', 'MCP request timed out');
  if (error instanceof UnauthorizedError || e?.name === 'UnauthorizedError' || e?.code === 401 || e?.status === 401) return new McpPublicError('auth_required', 'MCP authentication required; use /mcp-auth SERVER');
  if (e?.code === 403 || e?.status === 403) return new McpPublicError('denied', 'MCP authorization denied (403)');
  return new McpPublicError('failure', 'MCP request failed; server unavailable, invalid response, or protocol error');
}

export function boundedResult(value: unknown, maxBytes = 65536): string {
  let text: string;
  try { text = JSON.stringify(value) ?? 'null'; }
  catch { return '[MCP output omitted: value is too deeply nested or not JSON serializable]'; }
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text).subarray(0, maxBytes - 64).toString('utf8') + '\n[MCP output truncated]';
}

// Bound bytes before the SDK parses JSON or buffers an SSE event. Long-lived
// SSE connections may carry many bounded events without a cumulative cutoff.
async function boundedFetch(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], onLimit: (error: Error) => void): Promise<Response> {
  const response = await fetch(input, {...init, redirect: 'error'});
  if (!response.body) return response;
  const eventStream = response.headers.get('content-type')?.includes('text/event-stream');
  let bytes = 0, lineBytes = 0, previousCR = false;
  const limit = () => { const error = new McpLimitError('An MCP response on this connection exceeds 2 MiB; connection reset, pending actions were not retried'); onLimit(error); throw error; };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!eventStream) {
        bytes += chunk.byteLength;
        if (bytes > 2 * 1024 * 1024) limit();
      } else for (const byte of chunk) {
        if (++bytes > 2 * 1024 * 1024) limit();
        if (byte === 13 || byte === 10 && !previousCR) {
          if (lineBytes === 0) bytes = 0;
          lineBytes = 0;
        } else if (byte !== 10 || !previousCR) lineBytes++;
        previousCR = byte === 13;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}

export type ConnectionState = 'disabled' | 'disconnected' | 'connecting' | 'ready' | 'failed' | 'auth_required' | 'closed';
export interface ConnectionStatus { state: ConnectionState; toolCount: number; error?: string }

export class McpConnection {
  readonly config: ServerConfig;
  private client?: Client;
  private transport?: Transport;
  private oauth?: SessionOAuth;
  private connecting?: Promise<Tool[]>;
  private authenticating?: Promise<Tool[]>;
  private authRequestSignal?: AbortSignal;
  private lifetime = new AbortController();
  private reconnect = false;
  private responseErrors = new WeakMap<Client, Error>();
  private currentStatus: ConnectionStatus;

  constructor(readonly name: string, config: ServerConfig, readonly cwd = process.cwd()) {
    this.config = validateConfig({ servers: { [name]: config } }).servers[name];
    this.currentStatus = { state: config.enabled === false ? 'disabled' : 'disconnected', toolCount: 0 };
  }

  get status(): ConnectionStatus { return { ...this.currentStatus }; }

  private options(signal?: AbortSignal, onprogress?: (progress: Progress) => void) {
    const timeout = requestTimeout(this.config);
    return { signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, onprogress };
  }

  async connect(): Promise<Tool[]> {
    if (this.lifetime.signal.aborted) throw new Error('MCP connection closed');
    return this.authenticating ?? this.connectCurrent();
  }

  private async connectCurrent(): Promise<Tool[]> {
    if (this.lifetime.signal.aborted) throw new Error('MCP connection closed');
    if (this.config.enabled === false) throw new Error('MCP server is disabled');
    if (this.connecting) return this.connecting;
    this.connecting = this.establish();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }

  private async establish(): Promise<Tool[]> {
    this.currentStatus = { state: 'connecting', toolCount: 0 };
    try {
      if (this.config.url) resolveHeaders(this.config);
      const tools = await withDeadline(startupTimeout(this.config), [this.lifetime.signal], signal => this.open(signal));
      this.lifetime.signal.throwIfAborted();
      this.currentStatus = { state: 'ready', toolCount: tools.length };
      return tools;
    } catch (error) {
      const safe = publicError(error);
      if (!this.lifetime.signal.aborted) this.currentStatus = { state: safe instanceof McpPublicError && safe.kind === 'auth_required' ? 'auth_required' : 'failed', toolCount: 0, error: safe.message };
      throw safe;
    }
  }

  private async open(signal: AbortSignal): Promise<Tool[]> {
    if (this.client) {
      const client = this.client;
      try { return await this.listTools(client, signal, startupTimeout(this.config)); }
      catch (error) {
        await client.close().catch(() => {});
        if (this.client === client) this.client = undefined;
        throw error;
      }
    }
    const client = new Client({ name: 'harbor-mcp', version: '0.2.0' }, { capabilities: {} });
    const config = this.config;
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        if (!this.lifetime.signal.aborted) this.currentStatus = { state: 'disconnected', toolCount: 0 };
      }
    };
    const request: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('MCP requires HTTPS or loopback HTTP');
      // OAuth discovery may target another origin. Configured credentials must not.
      const headers = url.origin === new URL(config.url!).origin ? resolveHeaders(config) : new Headers();
      if (input instanceof Request) input.headers.forEach((value, key) => headers.set(key, value));
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      const signals = [signal, this.lifetime.signal, this.authRequestSignal, init?.signal, input instanceof Request ? input.signal : undefined].filter((s): s is AbortSignal => s != null);
      return boundedFetch(input, { ...init, headers, signal: AbortSignal.any(signals) }, error => {
        this.responseErrors.set(client, error);
        if (this.client === client) { this.client = undefined; this.reconnect = true; this.currentStatus = { state: 'failed', toolCount: 0, error: error.message }; }
        // Never replay failed actions. Only a later explicit action may reconnect.
        void client.close().catch(() => {});
      });
    };
    const transport = config.command
      ? new StdioClientTransport({ command: config.command, args: config.args, env: resolveEnvironment(config), cwd: config.cwd ? resolve(this.cwd, config.cwd) : this.cwd, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 })
      : config.transport === 'sse'
        ? new SSEClientTransport(new URL(config.url!), { authProvider: this.oauth, fetch: request, requestInit: { redirect: 'error' } })
        : new StreamableHTTPClientTransport(new URL(config.url!), { authProvider: this.oauth, requestInit: { redirect: 'error' }, fetch: request, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    this.transport = transport;
    const abort = () => { void client.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect(transport, { ...this.options(signal), timeout: startupTimeout(config), maxTotalTimeout: startupTimeout(config) });
      signal.throwIfAborted();
      this.client = client;
      this.reconnect = false;
      return await this.listTools(client, signal, startupTimeout(config));
    } catch (error) {
      await client.close().catch(() => {});
      if (this.client === client) this.client = undefined;
      throw signal.aborted ? signal.reason : this.responseErrors.get(client) ?? error;
    } finally { signal.removeEventListener('abort', abort); }
  }

  async authenticate(show: (url: string) => void): Promise<Tool[]> {
    if (this.authenticating) return this.authenticating;
    this.authenticating = this.login(show);
    try { return await this.authenticating; } finally { this.authenticating = undefined; }
  }

  private async login(show: (url: string) => void): Promise<Tool[]> {
    if (!this.config.oauth || !this.config.url) throw new Error('OAuth is not configured for this server');
    if (this.config.enabled === false || this.lifetime.signal.aborted) throw new Error('MCP server is disabled or closed');
    await this.connecting?.catch(() => {});
    await this.client?.close(); this.client = undefined;
    await this.oauth?.close();
    this.lifetime.signal.throwIfAborted();
    this.oauth = await SessionOAuth.start(this.config.oauth, show);
    const abort = () => { void this.oauth?.close(); };
    this.lifetime.signal.addEventListener('abort', abort, { once: true });
    try {
      this.lifetime.signal.throwIfAborted();
      try { return await this.connectCurrent(); } catch (error) { if (!this.oauth.authorizationStarted) throw error; }
      const code = await this.oauth.code;
      const transport = this.transport;
      if (!(transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport)) throw new Error('MCP OAuth transport unavailable');
      await withDeadline(startupTimeout(this.config), [this.lifetime.signal], async signal => {
        const onAbort = () => { void transport.close().catch(() => {}); };
        signal.addEventListener('abort', onAbort, { once: true });
        this.authRequestSignal = signal;
        try { await transport.finishAuth(code); signal.throwIfAborted(); }
        finally { this.authRequestSignal = undefined; signal.removeEventListener('abort', onAbort); }
      });
      return await this.connectCurrent();
    } catch (error) { throw publicError(error); }
    finally { this.lifetime.signal.removeEventListener('abort', abort); await this.oauth.close(); }
  }

  private async invoke<T>(fn: (client: Client, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('MCP request cancelled');
    if (!this.client && !this.reconnect) throw new Error('MCP server is disconnected');
    let client: Client | undefined;
    try {
      return await withDeadline(requestTimeout(this.config), [signal, this.lifetime.signal], async s => {
        if (!this.client && this.reconnect && !this.lifetime.signal.aborted) await this.connect();
        s.throwIfAborted();
        client = this.client;
        if (!client) throw new Error('MCP server is disconnected');
        return fn(client, s);
      });
    } catch (error) { throw signal?.aborted ? new Error('MCP request cancelled') : (client && this.responseErrors.get(client)) ?? publicError(error); }
  }

  private async listTools(client: Client, signal: AbortSignal, timeout = requestTimeout(this.config)): Promise<Tool[]> {
    if (!client.getServerCapabilities()?.tools) return [];
    const tools = await collectPages(async cursor => {
      signal.throwIfAborted();
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { ...this.options(signal), timeout, maxTotalTimeout: timeout });
      return { items: result.tools, nextCursor: result.nextCursor };
    });
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new McpLimitError('MCP catalog contains duplicate tool names');
      names.add(tool.name);
    }
    return tools.filter(t => (!this.config.allowTools || this.config.allowTools.includes(t.name)) && !this.config.denyTools?.includes(t.name));
  }

  tools(signal?: AbortSignal): Promise<Tool[]> { return this.invoke((c, s) => this.listTools(c, s), signal); }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, progress?: (p: Progress) => void) {
    if (this.config.denyTools?.includes(name) || this.config.allowTools && !this.config.allowTools.includes(name)) throw new Error('MCP tool excluded by configuration');
    return this.invoke((c, s) => c.callTool({ name, arguments: args }, CallToolResultSchema, this.options(s, progress)), signal);
  }

  resources(signal?: AbortSignal) {
    return this.invoke((c, s) => !c.getServerCapabilities()?.resources ? Promise.resolve([]) : collectPages(async cursor => {
      s.throwIfAborted();
      const r = await c.listResources(cursor === undefined ? undefined : { cursor }, this.options(s));
      return { items: r.resources, nextCursor: r.nextCursor };
    }), signal);
  }

  resourceTemplates(signal?: AbortSignal) {
    return this.invoke((c, s) => !c.getServerCapabilities()?.resources ? Promise.resolve([]) : collectPages(async cursor => {
      s.throwIfAborted();
      const r = await c.listResourceTemplates(cursor === undefined ? undefined : { cursor }, this.options(s));
      return { items: r.resourceTemplates, nextCursor: r.nextCursor };
    }), signal);
  }

  read(uri: string, signal?: AbortSignal) { return this.invoke((c, s) => c.readResource({ uri }, this.options(s)), signal); }

  prompts(signal?: AbortSignal) {
    return this.invoke((c, s) => !c.getServerCapabilities()?.prompts ? Promise.resolve([]) : collectPages(async cursor => {
      s.throwIfAborted();
      const r = await c.listPrompts(cursor === undefined ? undefined : { cursor }, this.options(s));
      return { items: r.prompts, nextCursor: r.nextCursor };
    }), signal);
  }

  prompt(name: string, args: Record<string, string>, signal?: AbortSignal) { return this.invoke((c, s) => c.getPrompt({ name, arguments: args }, this.options(s)), signal); }

  async close() {
    this.lifetime.abort(new DOMException('MCP connection closed', 'AbortError'));
    this.currentStatus = { state: 'closed', toolCount: 0 };
    this.oauth?.invalidateCredentials('all');
    try { await this.oauth?.close(); await this.client?.close(); }
    finally { try { await this.transport?.close(); } finally { this.client = undefined; } }
  }
}
