import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mcp from './index.ts';
import { startFixture } from './fixture.ts';

test('Pi registers schema-preserving tools, enforces call consent and never promotes remote readOnlyHint',async()=>{
  const fixture=await startFixture('http');
  const dir=await mkdtemp(join(tmpdir(),'pi-mcp-'));
  const path=join(dir,'mcp.json');
  await writeFile(path,JSON.stringify({servers:{fixture:fixture.config}}));
  const handlers=new Map<string,any>(),tools=new Map<string,any>(),commands=new Map<string,any>();
  let approved=true;const emissions:string[]=[];
  const pi={on:(n:string,f:any)=>handlers.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:(n:string,c:any)=>commands.set(n,c),registerFlag:()=>{},getFlag:()=>path,getActiveTools:()=>[...tools.keys()],setActiveTools:()=>{},events:{emit:(n:string)=>emissions.push(n)}};
  mcp(pi as any);
  const ctx={cwd:dir,hasUI:true,mode:'tui',isProjectTrusted:()=>false,ui:{confirm:async()=>approved,notify:()=>{}}};
  try{
    await handlers.get('session_start')({},ctx);
    const remote=[...tools.values()].find(t=>t.name.startsWith('mcp_fixture_echo_'));
    assert.ok(remote);
    assert.deepEqual(remote.parameters,{type:'object',properties:{text:{type:'string'},delay:{type:'number'}},required:['text']});
    approved=false;
    await assert.rejects(remote.execute('1',{text:'blocked'},undefined,undefined,ctx),/declined/i);
    approved=true;
    assert.match((await remote.execute('2',{text:'allowed'},undefined,undefined,ctx)).content[0].text,/allowed/);
    assert.deepEqual(emissions,[]);
    assert.ok(commands.has('mcp-auth'));
    assert.ok(tools.has('mcp'));
  }finally{await handlers.get('session_shutdown')();await fixture.close();await rm(dir,{recursive:true,force:true});}
});

test('session replacement invalidates old registered callbacks and project trust revocation blocks calls',async()=>{
  const fixture=await startFixture('http');
  const dir=await mkdtemp(join(tmpdir(),'pi-mcp-trust-'));
  const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'.pi'));
  await writeFile(join(dir,'.pi','mcp.json'),JSON.stringify({servers:{project:{...fixture.config,consent:'allow'}}}));
  const handlers=new Map<string,any>(),tools=new Map<string,any>();
  const pi={on:(n:string,f:any)=>handlers.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},registerFlag:()=>{},getFlag:()=>undefined,getActiveTools:()=>[...tools.keys()],setActiveTools:()=>{}};
  let trust=true;
  const ctx={cwd:dir,hasUI:false,mode:'json',isProjectTrusted:()=>trust,ui:{notify:()=>{}}};
  mcp(pi as any);
  try{
    await handlers.get('session_start')({},ctx);
    const old=[...tools.values()].find(t=>t.name.startsWith('mcp_project_'));assert.ok(old);
    trust=false;
    await assert.rejects(old.execute('1',{text:'blocked'},undefined,undefined,ctx),/trust/i);
    trust=true;
    await handlers.get('session_start')({},ctx);
    await assert.rejects(old.execute('2',{text:'expired'},undefined,undefined,ctx),/expired/i);
    const current=tools.get(old.name);assert.match((await current.execute('3',{text:'current'},undefined,undefined,ctx)).content[0].text,/current/);
  }finally{await handlers.get('session_shutdown')();await fixture.close();await rm(dir,{recursive:true,force:true});}
});


test('remote schemas cannot inject external references or oversized provider parameters',async()=>{
 const {McpConnection}=await import('./client.ts');
 const dir=await mkdtemp(join(tmpdir(),'pi-mcp-schema-'));const path=join(dir,'mcp.json');
 await writeFile(path,JSON.stringify({servers:{fixture:{url:'http://127.0.0.1:1',consent:'allow'}}}));
 const tools=new Map<string,any>(),handlers=new Map<string,any>();const warnings:string[]=[];
 const mocked=test.mock.method(McpConnection.prototype,'connect',async()=>[
  {name:'external',inputSchema:{type:'object',properties:{value:{$ref:'https://example.invalid/schema'}}}},
  {name:'large',inputSchema:{type:'object',description:'x'.repeat(33000)}},
  {name:'valid',inputSchema:{type:'object',properties:{value:{type:'string'}}}},
  {name:'recursive',inputSchema:{type:'object',properties:{child:{$ref:'#'}}}},
 ]);
 try{
  mcp({on:(n:string,h:any)=>handlers.set(n,h),registerTool:(t:any)=>tools.set(t.name,t),registerCommand(){},registerFlag(){},getFlag:()=>path,getActiveTools:()=>[...tools.keys()],setActiveTools:()=>{}} as any);
  await handlers.get('session_start')({}, {cwd:dir,hasUI:false,isProjectTrusted:()=>false,ui:{notify:(message:string)=>warnings.push(message)}});
  assert.equal([...tools.keys()].filter(name=>name.startsWith('mcp_fixture_')).length,2);
  assert.ok([...tools.keys()].some(name=>name.startsWith('mcp_fixture_valid_')));
  assert.equal(warnings.length,2);
 }finally{mocked.mock.restore();await handlers.get('session_shutdown')?.();await rm(dir,{recursive:true,force:true});}
});
