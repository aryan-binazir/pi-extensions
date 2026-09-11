import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { ServerConfig } from './client.ts';
import { configure } from './fixture-server.mjs';

export async function startFixture(kind:'stdio'|'http'|'sse',jsonResponse=false) {
  if(kind==='stdio') return {config:{command:process.execPath,args:[fileURLToPath(new URL('./fixture-server.mjs',import.meta.url))]} satisfies ServerConfig,close:async()=>{}};
  const sessions:Server[]=[];
  let legacy:SSEServerTransport|undefined;
  let modern:StreamableHTTPServerTransport|undefined;
  const http=createServer(async(req,res)=>{
    try {
      if(kind==='sse' && req.method==='GET') {
        legacy=new SSEServerTransport('/messages',res);
        const server=configure(new Server({name:'fixture',version:'1.0'},{capabilities:{tools:{},resources:{},prompts:{}}}));
        sessions.push(server);await server.connect(legacy);return;
      }
      if(kind==='sse') {await legacy!.handlePostMessage(req,res);return;}
      if(!modern || req.method==='POST' && !req.headers['mcp-session-id']){
        const server=configure(new Server({name:'fixture',version:'1.0'},{capabilities:{tools:{},resources:{},prompts:{}}}));
        modern=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:jsonResponse});sessions.push(server);await server.connect(modern);
      }
      await modern.handleRequest(req,res);
    } catch { if(!res.headersSent)res.writeHead(500);res.end(); }
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address=http.address() as {port:number};
  return {config:{url:`http://127.0.0.1:${address.port}/${kind}`,transport:kind} satisfies ServerConfig,close:async()=>{await Promise.all(sessions.map(s=>s.close()));http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}};
}
