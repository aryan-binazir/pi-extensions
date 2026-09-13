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
  let origin='';let authOrigin='';let challenge='';let tokenCalls=0;
  const headerObservations:{origin:string;key:string|undefined}[]=[];
  const sessions:Server[]=[];let sse:SSEServerTransport|undefined;
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
      const form=new URLSearchParams(body);assert.equal(form.get('code'),'fixture-code');assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),challenge);assert.equal(form.get('resource'),`${origin}/mcp`);tokenCalls++;return json({access_token:'fixture-secret',token_type:'Bearer',expires_in:3600,scope:'read'});
    }
    if(req.headers.authorization!=='Bearer fixture-secret'){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`});res.end();return;}
    if(kind==='sse' && req.method==='GET') {sse=new SSEServerTransport('/messages',res);const server=configure(new Server({name:'fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}}));sessions.push(server);await server.connect(sse);return;}
    if(kind==='sse'){await sse!.handlePostMessage(req,res);return;}
    const server=configure(new Server({name:'fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}}));sessions.push(server);const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(t);await t.handleRequest(req,res);
  };
  const http=createServer(handler);const authHttp=separateAuth?createServer(handler):undefined;
  if(authHttp)await new Promise<void>(resolve=>authHttp.listen(0,'127.0.0.1',resolve));
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
  authOrigin=authHttp?`http://127.0.0.1:${(authHttp.address() as {port:number}).port}`:origin;
  const c=new McpConnection('oauth',{headers:{'X-Api-Key':'fixture-origin-secret'},url:`${origin}/mcp`,transport:kind,oauth:{clientId:'fixture-client'}});
  const browserCalls:Promise<unknown>[]=[];
  try{
    const [tools, concurrentTools]=await Promise.all([c.authenticate(url=>{browserCalls.push(fetch(url));}), c.connect()]);
    assert.deepEqual(concurrentTools.map(t=>t.name),tools.map(t=>t.name));
    await Promise.all(browserCalls);
    assert.equal(tools[0].name,'echo');assert.equal(tokenCalls,1);
    assert.match(JSON.stringify(await c.call('echo',{text:'authenticated'})),/authenticated/);
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
