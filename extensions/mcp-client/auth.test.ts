import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import {configure} from './fixture-server.mjs';
import {McpConnection, boundedResult, validateConfig} from './client.ts';
import {SessionOAuth} from './oauth.ts';

for(const kind of ['http','sse'] as const)test(`${kind} reports 401/403 without echoing server secrets`,async()=>{
  let status=401;
  const server=createServer((_req,res)=>{res.writeHead(status);res.end('SECRET_DO_NOT_LOG');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;
  try{
    for(const code of [401,403]){status=code;const c=new McpConnection('auth',{url,transport:kind});try{await assert.rejects(c.connect(),error=>{assert.match(String(error),code===401?/auth/i:/403|failed/);assert.doesNotMatch(String(error),/SECRET/);return true;});}finally{await c.close();}}
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for(const kind of ['http','sse'] as const)test(`${kind} OAuth completes discovery and PKCE with validated callback state and session tokens`,async()=>{
  let origin='';let challenge='';let tokenCalls=0;
  const sessions:Server[]=[];let sse:SSEServerTransport|undefined;
  const http=createServer(async(req,res)=>{
    const url=new URL(req.url!,origin);
    const json=(data:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return json({resource:`${origin}/mcp`,authorization_servers:[origin],scopes_supported:['read']});
    if(url.pathname.startsWith('/.well-known/oauth-authorization-server'))return json({issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
    if(url.pathname==='/authorize'){
      challenge=url.searchParams.get('code_challenge')!;assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('resource'),`${origin}/mcp`);
      const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');res.writeHead(302,{location:callback.href});res.end();return;
    }
    if(url.pathname==='/token'){
      let body='';for await(const chunk of req)body+=chunk;
      const form=new URLSearchParams(body);assert.equal(form.get('code'),'fixture-code');assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),challenge);assert.equal(form.get('resource'),`${origin}/mcp`);tokenCalls++;return json({access_token:'fixture-secret',token_type:'Bearer',expires_in:3600,scope:'read'});
    }
    if(req.headers.authorization!=='Bearer fixture-secret'){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`});res.end();return;}
    if(kind==='sse' && req.method==='GET') {sse=new SSEServerTransport('/messages',res);const server=configure(new Server({name:'fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}}));sessions.push(server);await server.connect(sse);return;}
    if(kind==='sse'){await sse!.handlePostMessage(req,res);return;}
    const server=configure(new Server({name:'fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}}));sessions.push(server);const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(t);await t.handleRequest(req,res);
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
  const c=new McpConnection('oauth',{url:`${origin}/mcp`,transport:kind,oauth:{clientId:'fixture-client'}});
  const browserCalls:Promise<unknown>[]=[];
  try{
    const tools=await c.authenticate(url=>{browserCalls.push(fetch(url));});
    await Promise.all(browserCalls);
    assert.equal(tools[0].name,'echo');assert.equal(tokenCalls,1);
    assert.match(JSON.stringify(await c.call('echo',{text:'authenticated'})),/authenticated/);
  }finally{await c.close();await Promise.all(sessions.map(s=>s.close()));http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}
});

test('OAuth rejects Unicode state without crashing, ignores mismatches, and shutdown rejects pending authorization',async()=>{
  const oauth=await SessionOAuth.start({},()=>{});
  try{
    const bad=new URL(oauth.redirectUrl);bad.searchParams.set('state','é'.repeat(64));bad.searchParams.set('code','bad');
    assert.equal((await fetch(bad)).status,400);
    const pending=assert.rejects(oauth.code,/closed/);await oauth.close();await pending;
  }finally{await oauth.close();}
});

test('configuration rejects unsafe transports and output caps do not retain unbounded details',()=>{
  assert.throws(()=>validateConfig({servers:{x:{url:'http://remote.example/mcp'}}}),/HTTPS/);
  assert.throws(()=>validateConfig({servers:{x:{command:'x',timeoutMs:0}}}),/limit/);
  assert.ok(Buffer.byteLength(boundedResult({text:'x'.repeat(10000)},256))<=256);
});
