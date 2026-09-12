import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfig, toolName } from './client.ts';

test('config replaces complete entries while preserving unrelated servers and ignores untrusted project', () => {
  const global = { servers: { first: { command: 'original', env: { SECRET: 'hidden' } }, other: { command: 'other' } } };
  const project = { servers: { first: { command: 'project' } } };
  const explicit = { servers: { third: { command: 'explicit' } } };
  assert.deepEqual(mergeConfig(global, project, explicit, true).servers, {first:{command:'project'},other:{command:'other'},third:{command:'explicit'}});
  assert.equal(mergeConfig(global, project, explicit, false).servers.first.command, 'original');
  assert.notEqual(toolName('a_b','c'),toolName('a','b_c'));
});

import { McpConnection } from './client.ts';
import { startFixture } from './fixture.ts';

for (const transport of ['stdio','http','sse'] as const) {
  test(`${transport} supports tools, schema, resources, prompts, progress, cancellation and shutdown`, async () => {
    const fixture=await startFixture(transport);
    const connection=new McpConnection('fixture',fixture.config);
    try {
      const tools=await connection.connect();
      assert.equal(tools[0].name,'echo');
      assert.deepEqual(tools[0].inputSchema.properties,{text:{type:'string'},delay:{type:'number'}});
      const progress:number[]=[];
      const result=await connection.call('echo',{text:'hello'},undefined,p=>progress.push(p.progress));
      assert.equal((result.content as {text:string}[])[0].text,'hello');
      assert.deepEqual(progress,[1]);
      assert.equal(connection.status.state,'ready');
      assert.deepEqual((await connection.resourceTemplates()).map(t=>t.name),['item','second']);
      assert.equal((await connection.resources())[0].uri,'fixture://hello');
      assert.equal(((await connection.read('fixture://hello')).contents[0] as {text:string}).text,'resource text');
      assert.equal((await connection.prompts())[0].name,'greeting');
      assert.equal(((await connection.prompt('greeting',{})).messages[0].content as {text:string}).text,'prompt text');
      const abort=new AbortController();
      const pending=connection.call('echo',{text:'slow',delay:10000},abort.signal);
      setTimeout(()=>abort.abort(),30);
      await assert.rejects(pending,/cancel/i);
      assert.equal(((await connection.call('echo',{text:'still alive'})).content as {text:string}[])[0].text,'still alive');
      assert.equal(((await connection.call('echo',{text:'cancellation-count'})).content as {text:string}[])[0].text,'1');
      const [slow,fast]=await Promise.all([connection.call('echo',{text:'slow',delay:30}),connection.call('echo',{text:'fast'})]);
      assert.equal((slow.content as {text:string}[])[0].text,'slow');assert.equal((fast.content as {text:string}[])[0].text,'fast');
    } finally { await connection.close(); await fixture.close(); }
  });
}

test('call deadlines cancel server work, filters reject hidden tools, and stdio shutdown reaps the child',async()=>{
  const fixture=await startFixture('stdio');
  const config={...fixture.config,timeoutMs:1000,allowTools:['echo']};
  const c=new McpConnection('bounds',config);
  try{
    await c.connect();
    await assert.rejects(c.call('hidden',{}),/excluded/);
    c.config.toolTimeoutMs=30;
    await assert.rejects(c.call('echo',{text:'timeout',delay:1000}),/timed out/);
    c.config.toolTimeoutMs=1000;
    assert.equal(((await c.call('echo',{text:'cancellation-count'})).content as {text:string}[])[0].text,'1');
    const pid=Number(((await c.call('echo',{text:'process-id'})).content as {text:string}[])[0].text);
    assert.ok(pid>0);await c.close();assert.throws(()=>process.kill(pid,0),(error:any)=>error.code==='ESRCH');
    await assert.rejects(c.connect(),/closed/);
  }finally{await c.close();await fixture.close();}
});

for (const [transport,jsonResponse] of [['http',false],['http',true],['sse',false]] as const) test(`${transport} json=${jsonResponse} promptly rejects oversize and reconnects for a new call`, async () => {
 const fixture=await startFixture(transport,jsonResponse);const connection=new McpConnection('bounded', {...fixture.config,timeoutMs:3000});
 try {
  await connection.connect();const start=Date.now();
  await assert.rejects(connection.call('echo',{text:'x'.repeat(2*1024*1024+1)}),/exceeds 2 MiB/);
  assert.ok(Date.now()-start<1500,'Size violation must reject before the request deadline');
  assert.equal(((await connection.call('echo',{text:'new call'})).content as {text:string}[])[0].text,'new call');
 } finally {await connection.close();await fixture.close();}
});

test('SDK UnauthorizedError retains the actionable OAuth instruction',async()=>{
 const {UnauthorizedError}=await import('@modelcontextprotocol/sdk/client/auth.js');
 const {publicError}=await import('./client.ts');
 assert.match(publicError(new UnauthorizedError()).message,/mcp-auth/);
});

test('explicit reconnect replaces an exited stdio server without replaying its pending action',async()=>{
 const fixture=await startFixture('stdio');const connection=new McpConnection('restart',{...fixture.config,timeoutMs:1500});
 try {
  await connection.connect();
  const pid=Number(((await connection.call('echo',{text:'process-id'})).content as {text:string}[])[0].text);
  const pending=assert.rejects(connection.call('echo',{text:'in-flight',delay:10000}),/failed|disconnected/);
  process.kill(pid,'SIGTERM');
  await pending;
  await connection.connect();
  const newPid=Number(((await connection.call('echo',{text:'process-id'})).content as {text:string}[])[0].text);
  assert.notEqual(newPid,pid);
  assert.equal(((await connection.call('echo',{text:'after restart'})).content as {text:string}[])[0].text,'after restart');
 }finally{await connection.close();await fixture.close();}
});
