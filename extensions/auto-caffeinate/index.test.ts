import assert from 'node:assert/strict';
import test from 'node:test';
import { PowerKeeper, readPower, startInhibitor } from './power.ts';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('work requires AC, background survives settled, battery and shutdown release',async()=>{
 let power:'ac'|'battery'|'unknown'='unknown';let starts=0,stops=0;let now=0;
 const keeper=new PowerKeeper({power:async()=>power,start:()=>{starts++;return {stop:async()=>{stops++;},alive:()=>true};},now:()=>now,lingerMs:20,checkMs:10});
 await keeper.setAgent(true);assert.equal(starts,0);
 power='ac';await keeper.check();assert.equal(starts,1);
 await keeper.background('task',true);await keeper.setAgent(false);now=100;await keeper.check();assert.equal(stops,0);
 power='battery';await keeper.check();assert.equal(stops,1);
 power='ac';await keeper.check();assert.equal(starts,2);
 await keeper.background('task',false);now=110;await keeper.check();assert.equal(stops,1);
 now=130;await keeper.check();assert.equal(stops,2);
 await keeper.setAgent(true);await keeper.shutdown();assert.equal(starts,3);assert.equal(stops,3);
 await keeper.setAgent(true);assert.equal(starts,3);
});
test('Linux power distinguishes AC, battery and missing information',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-'));
 try{
  assert.equal(await readPower('linux',dir),'unknown');
  await mkdir(join(dir,'AC'));await writeFile(join(dir,'AC/type'),'Mains');await writeFile(join(dir,'AC/online'),'1');
  await mkdir(join(dir,'AA-broken'));await writeFile(join(dir,'AA-broken/type'),'Mains');
  assert.equal(await readPower('linux',dir),'ac');
  await writeFile(join(dir,'AC/online'),'0');assert.equal(await readPower('linux',dir),'battery');
  await writeFile(join(dir,'AC/online'),'garbage');assert.equal(await readPower('linux',dir),'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('awake status tracks inhibition, linger, power loss, child exit and shutdown',async()=>{
 let now=0,alive=true;let power:'ac'|'battery'='ac';const states:boolean[]=[];
 const keeper=new PowerKeeper({now:()=>now,power:async()=>power,lingerMs:20,
  start:()=>{alive=true;return {alive:()=>alive,stop:async()=>{alive=false;}};},
  onChange:awake=>states.push(awake)});
 await keeper.setAgent(true);await keeper.check();assert.deepEqual(states,[true]);
 await keeper.setAgent(false);now=10;await keeper.check();assert.deepEqual(states,[true]);
 now=30;await keeper.check();assert.deepEqual(states,[true,false]);
 await keeper.background('task',true);assert.deepEqual(states,[true,false,true]);
 power='battery';await keeper.check();assert.equal(states.at(-1),false);
 power='ac';await keeper.check();assert.equal(states.at(-1),true);
 alive=false;await keeper.check();assert.equal(states.at(-1),false);
 now+=30000;await keeper.check();assert.equal(states.at(-1),true);
 await keeper.shutdown();assert.equal(states.at(-1),false);
});

test('missing inhibitor never publishes awake',async()=>{
 const states:boolean[]=[];
 const keeper=new PowerKeeper({power:async()=> 'ac',start:()=>undefined,onChange:awake=>states.push(awake)});
 await keeper.setAgent(true);await keeper.shutdown();assert.deepEqual(states,[]);
});

test('unsupported systems never spawn an inhibitor',()=>assert.equal(startInhibitor('win32'),undefined));

import { spawn } from 'node:child_process';
test('Linux inhibitor uses a pipe, and cleanup reaps the real synthetic child',async()=>{
 let child:ReturnType<typeof spawn>|undefined;let seen:string[]=[];
 const launch:typeof spawn=((command:string,args:string[],options:any)=>{
  assert.equal(command,'systemd-inhibit');seen=args;
  assert.equal(args.at(-1),'/bin/cat');child=spawn('/bin/cat',[],options);return child;
 }) as typeof spawn;
 const inhibitor=startInhibitor('linux',launch)!;
 assert.ok(seen.includes('--what=idle'));assert.ok(!seen.includes('--what=idle:sleep'));assert.ok(seen.includes('--no-ask-password'));
 assert.ok(child!.stdin);
 await inhibitor.stop();assert.equal(inhibitor.alive(),false);
 assert.notEqual(child!.exitCode,null);
});
test('power cache coalesces event reads and watchdog refreshes it',async()=>{
 let checks=0;let power:'ac'|'battery'='ac';let stopped=0;
 const keeper=new PowerKeeper({power:async()=>{checks++;return power;},start:()=>({alive:()=>true,stop:async()=>{stopped++;}}),now:()=>0});
 await keeper.setAgent(true);await keeper.background('a',true);await keeper.background('b',true);assert.equal(checks,1);
 power='battery';await keeper.check();assert.equal(checks,2);assert.equal(stopped,1);await keeper.shutdown();
});
test('closing owner pipe releases Linux child without a kill signal',async()=>{
 let child:ReturnType<typeof spawn>|undefined;
 const launch:typeof spawn=((_command:string,args:string[],options:any)=>{assert.equal(args.at(-1),'/bin/cat');child=spawn('/bin/cat',[],options);return child;}) as typeof spawn;
 const inhibitor=startInhibitor('linux',launch)!;
 const exited=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child!.stdin!.end();await exited;
 assert.equal(inhibitor.alive(),false);assert.equal(child!.exitCode,0);await inhibitor.stop();
});
test('macOS adapter uses idle-only caffeinate tied to parent PID',async()=>{
 const launch:typeof spawn=((command:string,args:string[],options:any)=>{
  assert.equal(command,'/usr/bin/caffeinate');assert.deepEqual(args,['-i','-w',String(process.pid)]);
  return spawn(process.execPath,['-e','process.stdin.resume()'],options);
 }) as typeof spawn;
 const inhibitor=startInhibitor('darwin',launch)!;await inhibitor.stop();assert.equal(inhibitor.alive(),false);
});

test('missing inhibitor backs off instead of retrying each watchdog tick',async()=>{
 let now=0,starts=0;
 const keeper=new PowerKeeper({now:()=>now,power:async()=> 'ac',start:()=>{starts++;return undefined;}});
 try {await keeper.setAgent(true);for(now=2000;now<30000;now+=2000)await keeper.check();assert.equal(starts,1);await keeper.check();assert.equal(starts,2);}
 finally {await keeper.shutdown();}
});
