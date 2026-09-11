import { createHash } from 'node:crypto';

export interface ServerConfig {
  command?: string; args?: string[]; env?: Record<string,string>;
  url?: string; transport?: 'stdio'|'http'|'sse';
  headers?: Record<string,string>; oauth?: { clientId?:string; scope?:string };
  allowTools?: string[]; denyTools?: string[];
  consent?: 'ask'|'allow'; timeoutMs?:number; maxOutputBytes?:number;
}
export interface McpConfig { servers: Record<string,ServerConfig> }
export function mergeConfig(global:McpConfig, project:McpConfig, explicit:McpConfig, trusted:boolean):McpConfig {
  return {servers:{...global.servers,...(trusted?project.servers:{}),...explicit.servers}};
}
export function toolName(server:string, name:string) {
  const hash=createHash('sha256').update(JSON.stringify([server,name])).digest('hex').slice(0,16);
  return `mcp_${server.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,16)}_${name.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,20)}_${hash}`;
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, type Progress, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SessionOAuth } from './oauth.ts';

export function validateConfig(value:unknown):McpConfig {
  if(!value || typeof value!=='object' || !('servers' in value) || !value.servers || typeof value.servers!=='object' || Array.isArray(value.servers)) throw new Error('MCP config requires a servers object');
  const config=value as McpConfig;
  if(Object.keys(config.servers).length>32)throw new Error('MCP server limit is 32');
  for(const [name,server] of Object.entries(config.servers)) {
    if(!name || name.length>128 || !server || typeof server!=='object' || Array.isArray(server))throw new Error('Invalid MCP server entry');
    if(!!server.command===!!server.url)throw new Error('MCP server requires exactly one command or URL');
    if(server.command && (typeof server.command!=='string' || server.transport && server.transport!=='stdio'))throw new Error('Invalid MCP stdio config');
    if(server.url) {const u=new URL(server.url);if(u.username || u.password || u.hash || !['https:','http:'].includes(u.protocol) || u.protocol==='http:' && !['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('MCP requires HTTPS or loopback HTTP');if(server.transport && !['http','sse'].includes(server.transport))throw new Error('Invalid MCP HTTP transport');}
    for(const field of ['args','allowTools','denyTools'] as const)if(server[field]!==undefined && (!Array.isArray(server[field]) || server[field]!.some(x=>typeof x!=='string')))throw new Error('Invalid MCP string list');
    for(const field of ['env','headers'] as const)if(server[field]!==undefined && (!server[field] || typeof server[field]!=='object' || Array.isArray(server[field]) || Object.values(server[field]!).some(x=>typeof x!=='string')))throw new Error('Invalid MCP environment or headers');
    if(server.consent!==undefined && !['ask','allow'].includes(server.consent))throw new Error('Invalid MCP consent setting');
    for(const [field,min,max] of [['timeoutMs',10,120000],['maxOutputBytes',256,1048576]] as const)if(server[field]!==undefined && (!Number.isInteger(server[field]) || server[field]!<min || server[field]!>max))throw new Error('MCP limit outside supported range');
    if(server.oauth && (!server.url || typeof server.oauth!=='object' || server.oauth.clientId!==undefined && typeof server.oauth.clientId!=='string' || server.oauth.scope!==undefined && typeof server.oauth.scope!=='string'))throw new Error('Invalid MCP OAuth config');
  }
  return config;
}
function variables(values:Record<string,string>={}):Record<string,string> {
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,name:string)=>{const v=process.env[name];if(v===undefined)throw new Error('MCP environment reference unavailable');return v;})]));
}
class ResponseLimitError extends Error {}
export function publicError(error:unknown):Error {
  if(error instanceof ResponseLimitError)return error;
  const e=error as {name?:string;code?:number;status?:number};
  if(e?.name==='AbortError')return new Error('MCP request cancelled');
  if(e?.code===-32001 || e?.name==='TimeoutError')return new Error('MCP request timed out');
  if(error instanceof UnauthorizedError || e?.name==='UnauthorizedError' || e?.code===401 || e?.status===401)return new Error('MCP authentication required; use /mcp-auth SERVER');
  if(e?.code===403 || e?.status===403)return new Error('MCP authorization denied (403)');
  return new Error('MCP request failed; server unavailable, invalid response, or protocol error');
}
export function boundedResult(value:unknown,maxBytes=65536):string {
  const text=JSON.stringify(value);
  if(Buffer.byteLength(text)<=maxBytes)return text;
  return Buffer.from(text).subarray(0,maxBytes-64).toString('utf8')+'\n[MCP output truncated]';
}
// Bound bytes before the SDK parses JSON or buffers an SSE event. Long-lived
// SSE connections may carry many bounded events without a cumulative cutoff.
async function boundedFetch(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], onLimit: (error: Error) => void): Promise<Response> {
  const response = await fetch(input, {...init, redirect: 'error'});
  if (!response.body) return response;
  const eventStream = response.headers.get('content-type')?.includes('text/event-stream');
  let bytes = 0, lineBytes = 0, previousCR = false;
  const limit = () => { const error = new ResponseLimitError('MCP response exceeds 2 MiB; connection reset, pending actions were not retried'); onLimit(error); throw error; };
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
export class McpConnection {
  private client?:Client;
  private transport?:Transport;
  private oauth?:SessionOAuth;
  private connecting?:Promise<Tool[]>;
  private stopped=false;
  private reconnect=false;
  private responseErrors=new WeakMap<Client,Error>();
  constructor(readonly name:string,readonly config:ServerConfig,readonly cwd=process.cwd()) {validateConfig({servers:{[name]:config}});}
  private options(signal?:AbortSignal,onprogress?:(progress:Progress)=>void) {return {signal,timeout:this.config.timeoutMs??15000,maxTotalTimeout:this.config.timeoutMs??15000,resetTimeoutOnProgress:false,onprogress};}
  async connect():Promise<Tool[]> {
    if(this.stopped)throw new Error('MCP connection closed');
    if(this.connecting)return this.connecting;
    this.connecting=this.open();
    try{return await this.connecting;}finally{this.connecting=undefined;}
  }
  private async open():Promise<Tool[]> {
    if(this.client)return this.tools();
    const client=new Client({name:'pi-mcp-client',version:'0.1.0'},{capabilities:{}});
    const config=this.config;
    const request:typeof fetch=(input,init)=>boundedFetch(input,init,error=>{
      this.responseErrors.set(client,error);
      if(this.client===client){this.client=undefined;this.reconnect=true;}
      // Protocol onclose rejects every pending request immediately. Never replay
      // the failed action; only a later explicit call may open a fresh session.
      void client.close().catch(()=>{});
    });
    const transport=config.command ? new StdioClientTransport({command:config.command,args:config.args,env:{...getDefaultEnvironment(),...variables(config.env)},cwd:this.cwd,stderr:'ignore',maxBufferSize:2*1024*1024}) : config.transport==='sse' ? new SSEClientTransport(new URL(config.url!),{authProvider:this.oauth,fetch:request,requestInit:{headers:variables(config.headers),redirect:'error'},eventSourceInit:{fetch:(url,init)=>request(url,{...init,headers:{...variables(config.headers),...Object.fromEntries(new Headers(init?.headers))},redirect:'error'})}}) : new StreamableHTTPClientTransport(new URL(config.url!),{authProvider:this.oauth,requestInit:{headers:variables(config.headers),redirect:'error'},fetch:request,reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
    this.transport=transport;
    try{await client.connect(transport,this.options());if(this.stopped){await client.close();throw new Error('Closed');}this.client=client;this.reconnect=false;return await this.tools();}
    catch(error){await client.close().catch(()=>{});this.client=undefined;throw publicError(error);}
  }
  async authenticate(show:(url:string)=>void):Promise<Tool[]> {
    if(!this.config.oauth || !this.config.url)throw new Error('OAuth is not configured for this server');
    await this.client?.close();this.client=undefined;
    await this.oauth?.close();
    this.oauth=await SessionOAuth.start(this.config.oauth,show);
    try {
      try {return await this.connect();} catch {if(!this.oauth.authorizationStarted)throw new Error('MCP OAuth discovery failed');}
      const code=await this.oauth.code;
      const transport=this.transport;
      if(!(transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport))throw new Error('MCP OAuth transport unavailable');
      await transport.finishAuth(code);
      return await this.connect();
    } catch(error){throw publicError(error);} finally {await this.oauth.close();}
  }
  private async invoke<T>(fn:(client:Client)=>Promise<T>):Promise<T> {if(!this.client&&this.reconnect&&!this.stopped)await this.connect();const client=this.client;if(!client)throw new Error('MCP server is disconnected');try{return await fn(client);}catch(error){throw this.responseErrors.get(client)??publicError(error);}}
  async tools():Promise<Tool[]> {
    return this.invoke(async c=>{if(!c.getServerCapabilities()?.tools)return [];const items:Tool[]=[];let cursor:string|undefined;for(let page=0;page<32;page++){const result=await c.listTools(cursor?{cursor}:undefined,this.options());if(items.length+result.tools.length>256)throw new Error('Tool limit exceeded');items.push(...result.tools);if(items.length>256)throw new Error('Tool limit exceeded');cursor=result.nextCursor;if(!cursor)return items.filter(t=>(!this.config.allowTools || this.config.allowTools.includes(t.name)) && !this.config.denyTools?.includes(t.name));}throw new Error('Pagination limit exceeded');});
  }
  async call(name:string,args:Record<string,unknown>,signal?:AbortSignal,progress?:(p:Progress)=>void) {
    if(this.config.denyTools?.includes(name) || this.config.allowTools && !this.config.allowTools.includes(name))throw new Error('MCP tool excluded by configuration');
    try{return await this.invoke(c=>c.callTool({name,arguments:args},CallToolResultSchema,this.options(signal,progress)));}catch(error){if(signal?.aborted)throw new Error('MCP request cancelled');throw error;}
  }
  resources(signal?:AbortSignal) {return this.invoke(async c=>{const all=[];let cursor:string|undefined;for(let i=0;i<32;i++){const r=await c.listResources(cursor?{cursor}:undefined,this.options(signal));if(all.length+r.resources.length>256)throw new Error('Resource limit exceeded');all.push(...r.resources);if(all.length>256)throw new Error('Resource limit exceeded');if(!r.nextCursor)return all;cursor=r.nextCursor;}throw new Error('Pagination limit exceeded');});}
  read(uri:string,signal?:AbortSignal) {return this.invoke(c=>c.readResource({uri},this.options(signal)));}
  prompts(signal?:AbortSignal) {return this.invoke(async c=>{const all=[];let cursor:string|undefined;for(let i=0;i<32;i++){const r=await c.listPrompts(cursor?{cursor}:undefined,this.options(signal));if(all.length+r.prompts.length>256)throw new Error('Prompt limit exceeded');all.push(...r.prompts);if(all.length>256)throw new Error('Prompt limit exceeded');if(!r.nextCursor)return all;cursor=r.nextCursor;}throw new Error('Pagination limit exceeded');});}
  prompt(name:string,args:Record<string,string>,signal?:AbortSignal) {return this.invoke(c=>c.getPrompt({name,arguments:args},this.options(signal)));}
  async close(){this.stopped=true;this.oauth?.invalidateCredentials('all');try{await this.oauth?.close();await this.client?.close();}finally{try{await this.transport?.close();}finally{this.client=undefined;}}}
}
