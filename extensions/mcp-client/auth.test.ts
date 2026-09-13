import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,type RequestListener} from 'node:http';
import test from 'node:test';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import {configure} from './fixture-server.mjs';
import {McpConnection, boundedResult, validateConfig} from './client.ts';
import {SessionOAuth} from './oauth.ts';
import type { OAuthState, OAuthStore } from './credential-store.ts';

for(const kind of ['http','sse'] as const)test(`${kind} reports 401/403 without echoing server secrets`,async()=>{
  let status=401;
  const server=createServer((_req,res)=>{res.writeHead(status);res.end('SECRET_DO_NOT_LOG');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;
  try{
    for(const code of [401,403]){status=code;const c=new McpConnection('auth',{url,transport:kind});try{await assert.rejects(c.connect(),error=>{assert.match(String(error),code===401?/auth/i:/403|failed/);assert.doesNotMatch(String(error),/SECRET/);return true;});assert.equal(c.status.state,code===401?'auth_required':'failed');}finally{await c.close();}}
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for(const separateAuth of [false,true])for(const kind of ['http','sse'] as const)test(`${kind} OAuth separateAuth=${separateAuth} completes PKCE without leaking configured headers`,async()=>{
  let origin='';let authOrigin='';let challenge='';let tokenCalls=0;let refreshCalls=0;let currentAccess='fixture-secret';let currentRefresh='fixture-refresh';let rejectRefresh=false;
  let saved:OAuthState|undefined;let lease:Promise<unknown>=Promise.resolve();
  const store:OAuthStore={load:async()=>structuredClone(saved),save:async value=>{saved=structuredClone(value);},delete:async()=>{saved=undefined;},withLock:async<T>(fn:()=>Promise<T>)=>{const next=lease.catch(()=>{}).then(fn);lease=next;return next;}};
  const headerObservations:{origin:string;key:string|undefined}[]=[];
  const sessions:Server[]=[];const sseSessions=new Map<string,SSEServerTransport>();
  const handler:RequestListener=async(req,res)=>{
    const requestOrigin=`http://${req.headers.host}`;
    const url=new URL(req.url!,requestOrigin);
    if(url.pathname!=='/authorize')headerObservations.push({origin:requestOrigin,key:req.headers['x-api-key'] as string|undefined});
    const json=(data:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return json({resource:`${origin}/mcp`,authorization_servers:[authOrigin],scopes_supported:['read']});
    if(url.pathname.startsWith('/.well-known/oauth-authorization-server'))return json({issuer:authOrigin,authorization_endpoint:`${authOrigin}/authorize`,token_endpoint:`${authOrigin}/token`,response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
    if(url.pathname==='/authorize'){
      challenge=url.searchParams.get('code_challenge')!;assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('resource'),`${origin}/mcp`);
      const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');res.writeHead(302,{location:callback.href});res.end();return;
    }
    if(url.pathname==='/token'){
      let body='';for await(const chunk of req)body+=chunk;
      const form=new URLSearchParams(body);
      if(form.get('grant_type')==='refresh_token'){
        refreshCalls++;
        if(rejectRefresh)return json({error:'invalid_grant'},400);
        assert.equal(form.get('refresh_token'),currentRefresh);
        currentAccess=`fixture-refreshed-${refreshCalls}`;currentRefresh=`fixture-refresh-${refreshCalls}`;
        return json({access_token:currentAccess,refresh_token:currentRefresh,token_type:'Bearer',expires_in:3600});
      }
      assert.equal(form.get('code'),'fixture-code');assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),challenge);assert.equal(form.get('resource'),`${origin}/mcp`);tokenCalls++;return json({access_token:'fixture-secret',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:3600,scope:'read'});
    }
    if(req.headers.authorization!==`Bearer ${currentAccess}`){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`});res.end();return;}
    if(kind==='sse' && req.method==='GET') {const sse=new SSEServerTransport('/messages',res);sseSessions.set(sse.sessionId,sse);const server=configure(new Server({name:'fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}}));sessions.push(server);await server.connect(sse);return;}
    if(kind==='sse'){await sseSessions.get(url.searchParams.get('sessionId')!)!.handlePostMessage(req,res);return;}
    const server=configure(new Server({name:'fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}}));sessions.push(server);const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(t);await t.handleRequest(req,res);
  };
  const http=createServer(handler);const authHttp=separateAuth?createServer(handler):undefined;
  if(authHttp)await new Promise<void>(resolve=>authHttp.listen(0,'127.0.0.1',resolve));
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
  authOrigin=authHttp?`http://127.0.0.1:${(authHttp.address() as {port:number}).port}`:origin;
  const c=new McpConnection('oauth',{headers:{'X-Api-Key':'fixture-origin-secret'},url:`${origin}/mcp`,transport:kind,oauth:{clientId:'fixture-client'}},process.cwd(),store);
  const browserCalls:Promise<unknown>[]=[];
  try{
    const [tools, concurrentTools]=await Promise.all([c.authenticate(url=>{browserCalls.push(fetch(url));}), c.connect()]);
    assert.deepEqual(concurrentTools.map(t=>t.name),tools.map(t=>t.name));
    await Promise.all(browserCalls);
    assert.equal(tools[0].name,'echo');assert.equal(tokenCalls,1);
    assert.match(JSON.stringify(await c.call('echo',{text:'authenticated'})),/authenticated/);
    const peer=new McpConnection('oauth',c.config,process.cwd(),store);
    try {
      await peer.connect();currentAccess='expired-for-parallel-calls';
      await Promise.all([c.call('echo',{text:'one'}),c.call('echo',{text:'two'}),peer.call('echo',{text:'peer'})]);
      assert.equal(refreshCalls,1,'parallel calls and stale sessions refresh only once under the identity lease');
    }finally{await peer.close();}
    await c.close();
    assert.equal(saved?.tokens?.refresh_token,'fixture-refresh-1','shutdown preserves durable refresh credentials');
    currentAccess='expired';
    const resumed=new McpConnection('oauth',c.config,process.cwd(),store);
    try {
      assert.equal((await resumed.connect())[0].name,'echo');
      assert.equal(refreshCalls,2);assert.equal(browserCalls.length,1);
      assert.equal(saved?.tokens?.refresh_token,'fixture-refresh-2');
      assert.match(JSON.stringify(await resumed.call('echo',{text:'resumed'})),/resumed/);
    } finally {await resumed.close();}
    const again=new McpConnection('oauth',c.config,process.cwd(),store);
    try {await again.connect();assert.equal(refreshCalls,2);}finally{await again.close();}
    const beforeDecline=structuredClone(saved);
    const abandoned=new McpConnection('oauth',c.config,process.cwd(),store);
    const declines:Promise<unknown>[]=[];
    try {
      await assert.rejects(abandoned.authenticate(url=>{
        const authorization=new URL(url);const callback=new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state',authorization.searchParams.get('state')!);callback.searchParams.set('error','access_denied');
        declines.push(fetch(callback));
      }));
      await Promise.all(declines);assert.deepEqual(saved,beforeDecline,'abandoned login preserves saved sign-in');
      await abandoned.connect();
    }finally{await abandoned.close();}
    currentAccess='revoked';rejectRefresh=true;
    const revoked=new McpConnection('oauth',c.config,process.cwd(),store);
    try {
      await assert.rejects(revoked.connect(),/\/mcp-auth oauth/);
      assert.equal(revoked.status.state,'auth_required');
      assert.equal(browserCalls.length,1,'failed refresh must not silently open a browser');
      assert.equal(saved?.tokens,undefined);
    }finally{await revoked.close();}
    assert.ok(headerObservations.some(o=>o.origin===authOrigin));
    for(const observed of headerObservations)assert.equal(observed.key,observed.origin===origin?'fixture-origin-secret':undefined,`configured header scope at ${observed.origin}`);
  }finally{await c.close();await Promise.all(sessions.map(s=>s.close()));http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));if(authHttp){authHttp.closeAllConnections();await new Promise<void>(resolve=>authHttp.close(()=>resolve()));}}
});

test('OAuth rejects Unicode state without crashing, ignores mismatches, and shutdown rejects pending authorization',async()=>{
  const oauth=await SessionOAuth.start({},()=>{});
  try{
    const bad=new URL(oauth.redirectUrl);bad.searchParams.set('state','é'.repeat(64));bad.searchParams.set('code','bad');
    assert.equal((await fetch(bad)).status,400);
    const pending=assert.rejects(oauth.code,/closed/);await oauth.close();await pending;
  }finally{await oauth.close();}
});

test('closed OAuth listener rejects interactive reauthorization but retains refresh credentials', async () => {
  const { publicError } = await import('./client.ts');
  let shown = 0;
  const oauth = await SessionOAuth.start({ clientId: 'synthetic-client' }, () => { shown++; });
  oauth.saveTokens({ access_token: 'synthetic-access', token_type: 'Bearer', refresh_token: 'synthetic-refresh' });
  try {
    assert.equal(oauth.clientMetadata.client_name, 'Harbor MCP');
    await oauth.close();
    for (const action of [() => oauth.redirectToAuthorization(new URL('https://auth.example/authorize')), () => oauth.saveCodeVerifier('new-verifier')]) {
      assert.throws(action, error => { assert.match(publicError(error, { name: 'oauth', config: { url: 'https://mcp.example/mcp', oauth: {} } }).message, /sign-in required for this session; run \/mcp-auth oauth/i); return true; });
    }
    assert.equal(shown, 0);
    assert.equal(oauth.tokens()?.refresh_token, 'synthetic-refresh');
    oauth.saveTokens({ access_token: 'refreshed-synthetic', token_type: 'Bearer' });
    assert.equal(oauth.tokens()?.access_token, 'refreshed-synthetic');
  } finally { await oauth.close(); }
});

test('startup deadline aborts pending OAuth discovery fetches', async () => {
  const originalFetch = globalThis.fetch;
  let discoveryAborted = false, authorizations = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/mcp') return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://auth.example/metadata"' } });
    const signal = init?.signal;
    assert.ok(signal, 'discovery fetch needs the startup signal');
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { discoveryAborted = true; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const c = new McpConnection('deadline-auth', { url: 'https://mcp.example/mcp', oauth: { clientId: 'synthetic' }, startupTimeoutMs: 50 });
  try {
    await assert.rejects(c.authenticate(() => { authorizations++; }));
    assert.equal(discoveryAborted, true);
    assert.equal(authorizations, 0);
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});

test('configuration rejects unsafe transports and output caps do not retain unbounded details',()=>{
  assert.throws(()=>validateConfig({servers:{x:{url:'http://remote.example/mcp'}}}),/HTTPS/);
  assert.throws(()=>validateConfig({servers:{x:{command:'x',timeoutMs:0}}}),/limit/);
  assert.ok(Buffer.byteLength(boundedResult({text:'x'.repeat(10000)},256))<=256);
});

for(const kind of ['http','sse'] as const)test(`${kind} rejects non-loopback plain HTTP OAuth discovery before fetching it`,async()=>{
  const requests:string[]=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input)=>{
    const url=new URL(input instanceof Request?input.url:input);requests.push(url.href);
    if(url.pathname==='/mcp')return new Response(null,{status:401,headers:{'www-authenticate':'Bearer resource_metadata="http://auth.example/.well-known/oauth-protected-resource"'}});
    return new Response(null,{status:404});
  };
  const c=new McpConnection('unsafe-auth',{url:'https://mcp.example/mcp',transport:kind,oauth:{clientId:'fixture-client'},timeoutMs:1000});
  const timer=setTimeout(()=>{void c.close();},1500);
  try {
    await assert.rejects(c.authenticate(()=>{void c.close();}));
    assert.ok(requests.some(url=>url==='https://mcp.example/mcp'));
    assert.ok(requests.every(url=>!url.startsWith('http://auth.example/')),'Unsafe metadata destination must never receive a request');
  }finally{clearTimeout(timer);await c.close();globalThis.fetch=originalFetch;}
});
