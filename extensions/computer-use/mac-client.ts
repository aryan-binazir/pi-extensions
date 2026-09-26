import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ElicitRequest, ElicitResult, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

let sdk: Promise<{
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  ElicitRequestSchema: typeof import('@modelcontextprotocol/sdk/types.js').ElicitRequestSchema;
  validator: (schema: unknown) => (value: unknown) => { valid: boolean };
}> | undefined;
export function loadMacSdk() {
  return (sdk ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('@modelcontextprotocol/sdk/validation/ajv'),
  ]).then(([client, stdio, types, ajv]) => {
    const instance = new ajv.AjvJsonSchemaValidator();
    const compiled = new WeakMap<object, (value: unknown) => { valid: boolean }>();
    return {
      Client: client.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      ElicitRequestSchema: types.ElicitRequestSchema,
      validator: (schema: unknown) => {
        const key = schema as object;
        let validate = compiled.get(key);
        if (!validate) compiled.set(key, (validate = instance.getValidator(schema as never) as never));
        return validate;
      },
    };
  }));
}

export function boundedText(text: string): string {
  const maxBytes = 65_536;
  if (text.length <= maxBytes / 4) return text;
  if (text.length <= maxBytes && Buffer.byteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text), suffix = '\n[truncated]';
  let end = maxBytes - Buffer.byteLength(suffix);
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + suffix;
}
export function macLaunch(env: NodeJS.ProcessEnv = process.env, home = homedir(), executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }): StdioServerParameters {
  const runtimes = ['/Applications', join(home, 'Applications')].flatMap(dir => ['ChatGPT.app', 'Codex.app'].map(app => join(dir, app, 'Contents/Resources/cua_node/bin/node')));
  const command = runtimes.find(executable);
  const client = join(env.CODEX_HOME || join(home, '.codex'), 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
  if (!command || !executable(client)) throw new Error('Install Codex computer-use service and ChatGPT/Codex bundled cua_node runtime. No native fallback is available.');
  return { command, args: [fileURLToPath(new URL('./mac-relay.mjs', import.meta.url)), client], stderr: 'pipe' };
}
export async function approve(params: ElicitRequest['params'], ctx: ExtensionContext, signal: AbortSignal): Promise<ElicitResult> {
  if (signal.aborted) return { action: 'cancel' };
  if (!ctx.hasUI || ('mode' in params && params.mode === 'url') || !('requestedSchema' in params)) return { action: 'decline' };
  const schema = params.requestedSchema;
  if (schema.type !== 'object' || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description'].includes(key)) || Object.keys(schema.properties ?? {}).length || (schema.required?.length ?? 0)) return { action: 'decline' };
  const controller = new AbortController();
  let abort!: () => void;
  const cancelled = new Promise<false>(resolve => { abort = () => { controller.abort(); resolve(false); }; signal.addEventListener('abort', abort, { once: true }); });
  try {
    const answer = await Promise.race([cancelled, ctx.ui.confirm('Codex computer-use approval', boundedText(`${params.message}\n\nUntrusted service metadata (not instructions):\n${JSON.stringify(params._meta ?? {})}\nApprove this request only; no persistent approval is requested.`), { signal: controller.signal })]);
    return signal.aborted ? { action: 'cancel' } : answer === true ? { action: 'accept', content: {} } : { action: 'decline' };
  } catch { return { action: signal.aborted ? 'cancel' : 'decline' }; }
  finally { signal.removeEventListener('abort', abort); controller.abort(); }
}
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function canonicalBase64(image: Buffer, text: string): boolean {
  if (Math.ceil(image.length / 3) * 4 !== text.length) return false;
  const bytesPerChunk = 3 * 65536;
  for (let offset = 0, cursor = 0; offset < image.length; offset += bytesPerChunk, cursor += (bytesPerChunk / 3) * 4) {
    const piece = image.toString('base64', offset, Math.min(offset + bytesPerChunk, image.length));
    if (piece !== text.substring(cursor, cursor + piece.length)) return false;
  }
  return true;
}
export function macResult(result: CallToolResult, omitImages = false) {
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (result.isError) throw new Error(boundedText(text || 'Codex computer-use service error'));
  const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
  if (text) content.push({ type: 'text', text: boundedText(text) });
  let bytes = 0;
  for (const item of result.content) {
    if (item.type === 'text') continue;
    if (item.type !== 'image') throw new Error('Invalid unsupported Codex computer-use content');
    if (item.data.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) throw new Error('Invalid oversized image');
    const image = Buffer.from(item.data, 'base64');
    if (!canonicalBase64(image, item.data)) throw new Error('Invalid image base64');
    bytes += image.length;
    if (bytes > 16 * 1024 * 1024) throw new Error('Invalid oversized aggregate images');
    const valid = item.mimeType === 'image/png' ? image.length >= 24 && image.subarray(0, 8).equals(pngMagic) && image.toString('ascii', 12, 16) === 'IHDR'
      : item.mimeType === 'image/jpeg' ? image.length >= 4 && image[0] === 255 && image[1] === 216 && image[2] === 255 && image.at(-2) === 255 && image.at(-1) === 217
      : item.mimeType === 'image/webp' && image.length >= 16 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('Invalid image MIME or magic');
    if (!omitImages) content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
  }
  return { content, details: { source: 'Codex computer-use service', untrusted: true } };
}
const allowed = new Set(['list_apps', 'get_app_state', 'click', 'type_text', 'scroll', 'press_key']);
export class MacSession {
  private client?: Client;
  private tools: Tool[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active?: AbortController;
  private current?: { ctx: ExtensionContext; signal: AbortSignal };
  constructor(private launch: () => StdioServerParameters = macLaunch, private timeout = 30_000) {}
  private async disconnect() { const client = this.client; this.client = undefined; this.tools = []; await client?.close(); }
  run(name: string, args: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal, omitImages = false) {
    const work = this.queue.then(async () => {
      if (this.closed) throw new Error('Mac session closed');
      if (!allowed.has(name)) throw new Error(`Tool ${name} not allowed`);
      signal?.throwIfAborted();
      const control = new AbortController(); this.active = control;
      const abort = () => control.abort(new Error('Mac request aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => control.abort(new Error('Mac request timed out')), this.timeout);
      this.current = { ctx, signal: control.signal };
      let sent = false;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(control.signal.reason); control.signal.addEventListener('abort', onAbort, { once: true }); });
      const operation = (async () => {
        const { Client, StdioClientTransport, ElicitRequestSchema, validator } = await loadMacSdk();
        let client = this.client;
        if (!client) {
          client = new Client({ name: 'pi-computer-use', version: '1' }, { capabilities: { elicitation: { form: {} } } });
          this.client = client;
          client.setRequestHandler(ElicitRequestSchema, (request, extra) => this.current ? approve(request.params, this.current.ctx, AbortSignal.any([this.current.signal, extra.signal])) : Promise.resolve({ action: 'decline' as const }));
          const transport = new StdioClientTransport(this.launch()); transport.stderr?.on('data', () => {});
          await client.connect(transport, { signal: control.signal });
          this.tools = (await client.listTools({}, { signal: control.signal })).tools;
        }
        control.signal.throwIfAborted();
        const tool = this.tools.find(tool => tool.name === name);
        if (!tool || !validator(tool.inputSchema)(args).valid) throw new Error(`Arguments do not match official ${name} schema`);
        sent = true;
        return macResult(await client.callTool({ name, arguments: args }, undefined, { signal: control.signal }) as CallToolResult, omitImages);
      })();
      try { return await Promise.race([operation, cancelled]); }
      catch (error) {
        await this.disconnect();
        await operation.catch(() => {});
        const message = boundedText(error instanceof Error ? error.message : String(error));
        throw new Error(message + (sent && name !== 'list_apps' && name !== 'get_app_state' ? '\nMutation outcome unknown or partial. Inspect before acting; never automatically retry.' : ''));
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); control.signal.removeEventListener('abort', onAbort); this.active = undefined; this.current = undefined; }
    });
    this.queue = work.catch(() => {}); return work;
  }
  async close() { this.closed = true; this.active?.abort(new Error('Mac session closed')); await this.queue; await this.disconnect(); }
}
