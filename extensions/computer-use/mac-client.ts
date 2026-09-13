import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

export function boundedText(text: string): string {
  const bytes = Buffer.from(text), suffix = '\n[truncated]';
  if (bytes.length <= 65536) return text;
  let end = 65536 - Buffer.byteLength(suffix);
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
export function macResult(result: CallToolResult, omitImages = false) {
  if (result.isError) throw new Error(boundedText(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Codex computer-use service error'));
  const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (text) content.push({ type: 'text', text: boundedText(text) });
  let bytes = 0;
  for (const item of result.content) {
    if (item.type === 'text') continue;
    if (item.type !== 'image') throw new Error('Invalid unsupported Codex computer-use content');
    if (item.data.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) throw new Error('Invalid oversized image');
    if (item.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.data)) throw new Error('Invalid image base64');
    const image = Buffer.from(item.data, 'base64');
    if (image.toString('base64') !== item.data) throw new Error('Invalid image base64');
    bytes += image.length;
    if (bytes > 16 * 1024 * 1024) throw new Error('Invalid oversized aggregate images');
    const valid = item.mimeType === 'image/png' ? image.length >= 24 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && image.toString('ascii', 12, 16) === 'IHDR'
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
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active?: AbortController;
  private current?: { ctx: ExtensionContext; signal: AbortSignal };
  constructor(private launch: () => StdioServerParameters = macLaunch, private timeout = 30_000) {}
  private async disconnect() { const client = this.client; this.client = undefined; this.tools = []; await client?.close(); }
  run(name: string, args: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal, omitImages = false) {
    const work = this.tail.then(async () => {
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
        if (!this.client) {
          const client = new Client({ name: 'pi-computer-use', version: '1' }, { capabilities: { elicitation: { form: {} } } });
          this.client = client;
          client.setRequestHandler(ElicitRequestSchema, (request, extra) => this.current ? approve(request.params, this.current.ctx, AbortSignal.any([this.current.signal, extra.signal])) : Promise.resolve({ action: 'decline' as const }));
          const transport = new StdioClientTransport(this.launch()); transport.stderr?.on('data', () => {});
          await client.connect(transport, { signal: control.signal });
          this.tools = (await client.listTools({}, { signal: control.signal })).tools;
        }
        control.signal.throwIfAborted();
        const tool = this.tools.find(tool => tool.name === name);
        if (!tool || !new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid) throw new Error(`Arguments do not match official ${name} schema`);
        sent = true;
        return macResult(await this.client!.callTool({ name, arguments: args }, undefined, { signal: control.signal }) as CallToolResult, omitImages);
      })();
      try { return await Promise.race([operation, cancelled]); }
      catch (error) {
        await this.disconnect();
        await operation.catch(() => {});
        const message = boundedText(error instanceof Error ? error.message : String(error));
        throw new Error(message + (sent && name !== 'list_apps' && name !== 'get_app_state' ? '\nMutation outcome unknown or partial. Inspect before acting; never automatically retry.' : ''));
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); control.signal.removeEventListener('abort', onAbort); this.active = undefined; this.current = undefined; }
    });
    this.tail = work.catch(() => {}); return work;
  }
  async close() { this.closed = true; this.active?.abort(new Error('Mac session closed')); await this.tail; await this.disconnect(); }
}
