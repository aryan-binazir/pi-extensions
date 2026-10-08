import {Socket} from 'node:net';
import type {Duplex} from 'node:stream';
import type {ExtensionAPI, ToolDefinition, ToolInfo} from '@earendil-works/pi-coding-agent';
import {abortable} from './cancellation.ts';

type Definition = Pick<ToolInfo, 'name' | 'description' | 'parameters' | 'annotations' | 'namespace'>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>>;
interface Message {type: string; id?: number; name?: string; args?: unknown; tools?: Definition[]; result?: Result; error?: string}
export interface ConnectorBridge {
  tools: Definition[];
  execute(name: string, args: unknown, signal: AbortSignal): Promise<Result>;
}
export const CONNECTOR_FRAME_LIMIT = 1024 * 1024;
const MAX_PENDING = 32;

function channel(stream: Duplex, receive: (message: Message) => void, closed: (error: Error) => void) {
  let buffer = '', ended = false;
  const fail = (error = new Error('Connector bridge closed')) => {
    if (ended) return;
    ended = true; buffer = ''; stream.destroy(); closed(error);
  };
  stream.setEncoding('utf8');
  stream.on('error', fail);
  stream.on('close', () => fail());
  stream.on('end', () => fail());
  stream.on('data', (chunk: string) => {
    if (ended) return;
    buffer += chunk;
    try {
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > CONNECTOR_FRAME_LIMIT) throw new Error('Connector bridge frame exceeds 1 MiB');
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof (message as Message).type !== 'string') throw new Error('Invalid connector bridge message');
        receive(message as Message);
      }
      if (Buffer.byteLength(buffer) > CONNECTOR_FRAME_LIMIT) throw new Error('Connector bridge frame exceeds 1 MiB');
    } catch (error) { fail(error instanceof Error ? error : new Error('Invalid connector bridge message')); }
  });
  return {
    close: fail,
    send(message: Message) {
      if (ended) throw new Error('Connector bridge closed');
      const json = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(json) > CONNECTOR_FRAME_LIMIT || stream.writableLength > CONNECTOR_FRAME_LIMIT * 2) throw new Error('Connector bridge response exceeds its buffer limit');
      stream.write(json);
    },
  };
}

export function attachConnectorBridge(stream: Duplex, bridge: ConnectorBridge, signal: AbortSignal): () => void {
  const requests = new Map<number, AbortController>();
  const lifecycle = new AbortController();
  const peer = channel(stream, message => {
    if (!Number.isSafeInteger(message.id) || message.id! < 1) throw new Error('Invalid connector request id');
    if (message.type === 'cancel') { requests.get(message.id!)?.abort(); return; }
    if (message.type !== 'call' || typeof message.name !== 'string' || requests.has(message.id!)) throw new Error('Invalid connector request');
    if (requests.size >= MAX_PENDING) throw new Error('Too many outstanding connector requests');
    const controller = new AbortController();
    requests.set(message.id!, controller);
    const callSignal = AbortSignal.any([signal, lifecycle.signal, controller.signal]);
    void (async () => {
      try {
        if (!bridge.tools.some(tool => tool.name === message.name)) throw new Error(`Connector tool was not delegated to this child: ${message.name}`);
        const result = await abortable(bridge.execute(message.name!, message.args, callSignal), callSignal);
        if (!callSignal.aborted) peer.send({type: 'result', id: message.id, result});
      } catch (error) {
        if (!callSignal.aborted) {
          try { peer.send({type: 'result', id: message.id, error: error instanceof Error ? error.message : 'Connector execution failed'}); }
          catch { peer.close(new Error('Connector bridge response failed')); }
        }
      } finally { requests.delete(message.id!); }
    })();
  }, () => {lifecycle.abort(); for (const controller of requests.values()) controller.abort(); requests.clear();});
  const stop = () => peer.close();
  signal.addEventListener('abort', stop, {once: true});
  try { peer.send({type: 'tools', tools: bridge.tools}); }
  catch (error) { peer.close(); throw error; }
  if (signal.aborted) stop();
  return () => {signal.removeEventListener('abort', stop); stop();};
}

export default async function connectorTools(pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_SUBAGENT_TOOL_BRIDGE !== '1') throw new Error('Connector bridge requires a delegated child process');
  const stream = new Socket({fd: 5, readable: true, writable: true});
  let nextId = 0;
  const pending = new Map<number, {resolve: (result: Result) => void; reject: (error: Error) => void}>();
  let resolveTools!: (tools: Definition[]) => void, rejectTools!: (error: Error) => void;
  let initialized = false;
  const definitions = new Promise<Definition[]>((resolve, reject) => {resolveTools = resolve; rejectTools = reject;});
  const peer = channel(stream, message => {
    if (message.type === 'tools' && !initialized && Array.isArray(message.tools)) {
      initialized = true; resolveTools(message.tools); return;
    }
    if (message.type !== 'result' || !Number.isSafeInteger(message.id)) throw new Error('Invalid connector response');
    const request = pending.get(message.id!);
    if (!request) return;
    pending.delete(message.id!);
    if (message.error) request.reject(new Error(message.error));
    else if (message.result) request.resolve(message.result);
    else throw new Error('Missing connector result');
  }, error => {rejectTools(error); for (const request of pending.values()) request.reject(error); pending.clear();});
  pi.on('session_shutdown', () => peer.close());
  for (const tool of await definitions) pi.registerTool({
    ...tool, label: tool.name,
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      if (pending.size >= MAX_PENDING) throw new Error('Too many outstanding connector calls');
      const id = ++nextId;
      const response = new Promise<Result>((resolve, reject) => pending.set(id, {resolve, reject}));
      const cancel = () => {pending.get(id)?.reject(new Error('Connector call aborted')); pending.delete(id); try {peer.send({type: 'cancel', id});} catch {}}
      signal?.addEventListener('abort', cancel, {once: true});
      try { peer.send({type: 'call', id, name: tool.name, args}); return await response; }
      finally {signal?.removeEventListener('abort', cancel); pending.delete(id);}
    },
  });
}
