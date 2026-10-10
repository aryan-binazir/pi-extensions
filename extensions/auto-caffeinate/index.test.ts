import assert from 'node:assert/strict';
import test from 'node:test';
import { inhibitFlags, PowerKeeper, readPower, startInhibitor, type KeeperOptions } from './power.ts';
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
  assert.equal(await readPower('linux',dir),'ac');
  assert.equal(await readPower('linux',join(dir,'missing')),'unknown');
  await mkdir(join(dir,'BAT0'));await writeFile(join(dir,'BAT0/type'),'Battery');
  assert.equal(await readPower('linux',dir),'unknown');
  await mkdir(join(dir,'AC'));await writeFile(join(dir,'AC/type'),'Mains');await writeFile(join(dir,'AC/online'),'1');
  await mkdir(join(dir,'AA-broken'));await writeFile(join(dir,'AA-broken/type'),'Mains');
  assert.equal(await readPower('linux',dir),'ac');
  await writeFile(join(dir,'AC/online'),'0');assert.equal(await readPower('linux',dir),'battery');
  await writeFile(join(dir,'AC/online'),'garbage');assert.equal(await readPower('linux',dir),'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('programmable USB power keeps ongoing work inhibited until unplugged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-usb-'));
 let starts=0,stops=0,alive=false;
 const keeper=new PowerKeeper({power:()=>readPower('linux',dir),start:()=>{
  starts++;alive=true;return {alive:()=>alive,stop:async()=>{stops++;alive=false;}};
 }});
 try{
  await mkdir(join(dir,'USB'));await writeFile(join(dir,'USB/type'),'USB\n');
  await writeFile(join(dir,'USB/online'),'1\n');
  await keeper.setAgent(true);assert.equal(starts,1);assert.equal(alive,true);
  for(const online of ['2','3']){
   await writeFile(join(dir,'USB/online'),`${online}\n`);await keeper.check();
   assert.equal(alive,true,`online=${online} retains inhibition`);
   assert.equal(starts,1);assert.equal(stops,0);
   assert.equal(await readPower('linux',dir),'ac');
  }
  await writeFile(join(dir,'USB/online'),'0\n');await keeper.check();
  assert.equal(alive,false);assert.equal(stops,1);
 }finally{await keeper.shutdown();await rm(dir,{recursive:true,force:true});}
});
for(const type of ['Mains','USB','USB_C','USB_PD','USB_PD_DRP','Wireless']){
 test(`Linux ${type} recognizes fixed and programmable power alongside offline mains`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-power-online-'));
  try{
   await mkdir(join(dir,'SUPPLY'));await writeFile(join(dir,'SUPPLY/type'),type);
   assert.equal(await readPower('linux',dir),'unknown');
   for(const online of ['','garbage','4','-1','02','+2','2.0']){
    await writeFile(join(dir,'SUPPLY/online'),online);assert.equal(await readPower('linux',dir),'unknown',online);
   }
   await writeFile(join(dir,'SUPPLY/online'),'0\n');assert.equal(await readPower('linux',dir),'battery');
   for(const online of ['1','2','3']){
    await writeFile(join(dir,'SUPPLY/online'),`${online}\n`);assert.equal(await readPower('linux',dir),'ac',online);
   }
   await mkdir(join(dir,'AC'));await writeFile(join(dir,'AC/type'),'Mains');await writeFile(join(dir,'AC/online'),'0');
   for(const online of ['1','2','3']){
    await writeFile(join(dir,'SUPPLY/online'),`${online}\n`);assert.equal(await readPower('linux',dir),'ac',online);
   }
   await writeFile(join(dir,'SUPPLY/online'),'4');assert.equal(await readPower('linux',dir),'battery');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('online values do not make unknown supply types external power',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-unknown-'));
 try{
  await mkdir(join(dir,'SUPPLY'));await writeFile(join(dir,'SUPPLY/type'),'Unknown');
  for(const online of ['1','2','3']){
   await writeFile(join(dir,'SUPPLY/online'),online);assert.equal(await readPower('linux',dir),'unknown');
  }
  await mkdir(join(dir,'AC'));await writeFile(join(dir,'AC/type'),'Mains');await writeFile(join(dir,'AC/online'),'0');
  assert.equal(await readPower('linux',dir),'battery');
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

test('unsupported systems never spawn an inhibitor',async()=>assert.equal(await startInhibitor('win32'),undefined));

import { spawn } from 'node:child_process';
test('Linux inhibitor uses a pipe, and cleanup reaps the real synthetic child',async()=>{
 let child:ReturnType<typeof spawn>|undefined;let seen:string[]=[];
 const launch:typeof spawn=((command:string,args:string[],options:any)=>{
  assert.equal(command,'systemd-inhibit');seen=args;
  assert.equal(args.at(-1),'/bin/cat');child=spawn('/bin/cat',[],options);return child;
 }) as typeof spawn;
 let changed=()=>{};const confirmed=new Promise<void>(resolve=>{changed=resolve;});
 const inhibitor=(await startInhibitor('linux',launch,()=>changed(),async()=>['--no-ask-password']))!;
 assert.ok(seen.includes('--what=idle'));assert.ok(!seen.includes('--what=idle:sleep'));assert.ok(seen.includes('--no-ask-password'));
 assert.ok(child!.stdin);
 assert.equal(inhibitor.alive(),true);assert.equal(inhibitor.held?.(),false,'not held until the command echoes');
 await confirmed;assert.equal(inhibitor.held?.(),true);
 await inhibitor.stop();assert.equal(inhibitor.alive(),false);assert.equal(inhibitor.held?.(),false);
 assert.notEqual(child!.exitCode,null);
});
test('power cache coalesces event reads while a forced check re-reads it',async()=>{
 let checks=0;let power:'ac'|'battery'='ac';let stopped=0;
 const keeper=new PowerKeeper({power:async()=>{checks++;return power;},start:()=>({alive:()=>true,stop:async()=>{stopped++;}}),now:()=>0});
 await keeper.setAgent(true);await keeper.background('a',true);await keeper.background('b',true);assert.equal(checks,1);
 power='battery';await keeper.check();assert.equal(checks,2);assert.equal(stopped,1);await keeper.shutdown();
});
test('closing owner pipe releases Linux child without a kill signal',async()=>{
 let child:ReturnType<typeof spawn>|undefined;
 const launch:typeof spawn=((_command:string,args:string[],options:any)=>{assert.equal(args.at(-1),'/bin/cat');child=spawn('/bin/cat',[],options);return child;}) as typeof spawn;
 const inhibitor=(await startInhibitor('linux',launch,()=>{},async()=>[]))!;
 const exited=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child!.stdin!.end();await exited;
 assert.equal(inhibitor.alive(),false);assert.equal(child!.exitCode,0);await inhibitor.stop();
});
test('macOS adapter uses idle-only caffeinate tied to parent PID',async()=>{
 const launch:typeof spawn=((command:string,args:string[],options:any)=>{
  assert.equal(command,'/usr/bin/caffeinate');assert.deepEqual(args,['-i','-w',String(process.pid)]);
  return spawn(process.execPath,['-e','process.stdin.resume()'],options);
 }) as typeof spawn;
 const inhibitor=(await startInhibitor('darwin',launch))!;assert.equal(inhibitor.held?.(),true);await inhibitor.stop();assert.equal(inhibitor.alive(),false);
});
test('systemd-inhibit receives --no-ask-password only when its help lists it',async()=>{
 const v255='  -h --help               Show this help\n     --mode=MODE          One of block or delay\n     --list               List active inhibitors\n';
 const v257=`${v255}     --no-ask-password    Do not attempt interactive authorization\n`;
 assert.deepEqual(await inhibitFlags(async()=>({stdout:v255})),[]);
 assert.deepEqual(await inhibitFlags(async()=>({stdout:v257})),['--no-ask-password']);
 await assert.rejects(inhibitFlags(async()=>{throw new Error('spawn systemd-inhibit ETIMEDOUT');}));
 const keeper=new PowerKeeper({power:async()=>'ac',start:changed=>startInhibitor('linux',(()=>assert.fail('launched without a flag check')) as typeof spawn,changed,()=>Promise.reject(new Error('timed out')))});
 try{await assert.doesNotReject(keeper.setAgent(true));}finally{await keeper.shutdown();}
});
test('a helper that exits at once never reports Awake, while a working one does once it holds the lock',{timeout:10000},async()=>{
 let now=0,launches=0,exit:string[]=['-e','process.exit(1)'];const states:boolean[]=[];let changed=()=>{};
 const launch=((_command:string,args:string[],options:any)=>{
  launches++;assert.ok(!args.includes('--no-ask-password'));return spawn(process.execPath,exit,options);
 }) as typeof spawn;
 const keeper=new PowerKeeper({now:()=>now,power:async()=>'ac',onChange:awake=>{states.push(awake);changed();},
  start:onChange=>startInhibitor('linux',launch,()=>{onChange();changed();},async()=>[])});
 const next=()=>new Promise<void>(resolve=>{changed=resolve;});
 try{
  let gone=next();await keeper.setAgent(true);await gone;await keeper.check();
  now=30000;gone=next();await keeper.check();await gone;await keeper.check();
  assert.equal(launches,2,'the dead helper is retried after its backoff');assert.deepEqual(states,[]);
  exit=['-e','process.stdin.pipe(process.stdout)'];now=60000;const held=next();await keeper.check();
  assert.deepEqual(states,[]);await held;assert.deepEqual(states,[true]);
 }finally{await keeper.shutdown();}
 assert.deepEqual(states,[true,false]);
});

test('missing inhibitor backs off instead of retrying each watchdog tick',async()=>{
 let now=0,starts=0;
 const keeper=new PowerKeeper({now:()=>now,power:async()=> 'ac',start:()=>{starts++;return undefined;}});
 try {await keeper.setAgent(true);for(now=2000;now<30000;now+=2000)await keeper.check();assert.equal(starts,1);await keeper.check();assert.equal(starts,2);}
 finally {await keeper.shutdown();}
});

test('throwing status callbacks never reject checks or skip the next power read',async()=>{
 let reads=0,stops=0;let power:'ac'|'battery'='ac';const states:boolean[]=[];
 const keeper=new PowerKeeper({power:async()=>{reads++;return power;},
  start:()=>({alive:()=>true,stop:async()=>{stops++;}}),
  onChange:awake=>{states.push(awake);throw new Error('stale UI context');}});
 try{
  await assert.doesNotReject(keeper.background('task',true));assert.equal(reads,1);
  power='battery';await assert.doesNotReject(keeper.check());assert.equal(reads,2);assert.equal(stops,1);
  power='ac';await assert.doesNotReject(keeper.check());assert.equal(reads,3);
  await assert.doesNotReject(keeper.shutdown());assert.equal(stops,2);
  assert.deepEqual(states,[true,false,true,false]);
 }finally{await keeper.shutdown();}
});

test('the watchdog only ticks while work is pending',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 let reads=0,stops=0,ticks=0;
 const idle=async(ms:number)=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));};
 const keeper=new PowerKeeper({power:async()=>{reads++;return 'ac';},now:()=>{ticks++;return Date.now();},
  start:()=>({alive:()=>true,stop:async()=>{stops++;}}),lingerMs:20,checkMs:5,powerPollMs:0});
 try{
  keeper.start();
  const quiet=ticks;await idle(60);
  assert.equal(ticks,quiet,'a started but idle session never wakes the event loop');
  assert.equal(reads,0);
  await keeper.setAgent(true);assert.equal(reads,1);
  const working=reads;await idle(60);
  assert.ok(reads>working,'the watchdog polls power while the agent works');
  await keeper.setAgent(false);
  await idle(80);
  assert.equal(stops,1,'linger still expires with no event to drive it');
  const settled=ticks;await idle(60);
  assert.equal(ticks,settled,'and the watchdog stands down once work is gone');
 }finally{await keeper.shutdown();}
});

test('cached supply types follow devices appearing and disappearing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-hotplug-'));
 try{
  await mkdir(join(dir,'AC'));await writeFile(join(dir,'AC/type'),'Mains');await writeFile(join(dir,'AC/online'),'1');
  assert.equal(await readPower('linux',dir),'ac');
  await mkdir(join(dir,'USBC'));await writeFile(join(dir,'USBC/type'),'USB_PD');await writeFile(join(dir,'USBC/online'),'0');
  await writeFile(join(dir,'AC/online'),'0');
  assert.equal(await readPower('linux',dir),'battery');
  await writeFile(join(dir,'USBC/online'),'1');
  assert.equal(await readPower('linux',dir),'ac');
  await rm(join(dir,'USBC'),{recursive:true});await rm(join(dir,'AC'),{recursive:true});
  await mkdir(join(dir,'BAT0'));await writeFile(join(dir,'BAT0/type'),'Battery');
  assert.equal(await readPower('linux',dir),'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Linux ignores peripheral batteries when deciding whether a machine runs on AC',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-scope-'));
 const fixture=async(name:string,supplies:Record<string,Record<string,string>>)=>{
  const root=join(dir,name);await mkdir(root);
  for(const [supply,files] of Object.entries(supplies)){
   await mkdir(join(root,supply));for(const [file,value] of Object.entries(files))await writeFile(join(root,supply,file),`${value}\n`);
  }
  return readPower('linux',root);
 };
 const mouse={type:'Battery',scope:'Device'};
 try{
  assert.equal(await fixture('desktop',{}),'ac');
  assert.equal(await fixture('desktop-mouse',{hidpp_battery_0:mouse,hid_headset:mouse}),'ac');
  assert.equal(await fixture('desktop-type-c',{'ucsi-source-psy-USBC000:001':{type:'USB',scope:'Device',online:'0'}}),'ac');
  assert.equal(await fixture('laptop-ac',{AC:{type:'Mains',online:'1'},BAT0:{type:'Battery'},hidpp_battery_0:mouse}),'ac');
  assert.equal(await fixture('laptop-battery',{AC:{type:'Mains',online:'0'},BAT0:{type:'Battery',scope:'System'},hidpp_battery_0:mouse}),'battery');
  assert.equal(await fixture('laptop-charging-a-device',{BAT0:{type:'Battery'},'source-psy':{type:'USB',scope:'Device',online:'1'}}),'unknown');
  assert.equal(await fixture('system-battery-without-mains',{ups:{type:'Battery',scope:'System'},hidpp_battery_0:mouse}),'unknown');
  assert.equal(await fixture('unknown-scope-battery',{BAT0:{type:'Battery',scope:'Unknown'}}),'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a supply listed before its attributes exist is rescanned instead of cached',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-hotplug-attrs-'));
 try{
  await mkdir(join(dir,'hidpp_battery_0'));assert.equal(await readPower('linux',dir),'unknown');
  await writeFile(join(dir,'hidpp_battery_0/type'),'Battery\n');await writeFile(join(dir,'hidpp_battery_0/scope'),'Device\n');
  assert.equal(await readPower('linux',dir),'ac');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a peripheral battery appearing on a desktop keeps it on AC until a system supply appears',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-power-peripheral-'));
 try{
  assert.equal(await readPower('linux',dir),'ac');
  await mkdir(join(dir,'hidpp_battery_0'));await writeFile(join(dir,'hidpp_battery_0/scope'),'Device\n');await writeFile(join(dir,'hidpp_battery_0/type'),'Battery\n');
  assert.equal(await readPower('linux',dir),'ac');
  await mkdir(join(dir,'BAT0'));await writeFile(join(dir,'BAT0/type'),'Battery\n');
  assert.equal(await readPower('linux',dir),'unknown');
  await rm(join(dir,'BAT0'),{recursive:true});
  assert.equal(await readPower('linux',dir),'ac');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('starting work reuses a reading under five seconds old and settling never re-reads power',async()=>{
 let now=0,reads=0;
 const keeper=new PowerKeeper({now:()=>now,power:async()=>{reads++;return 'ac';},start:()=>({alive:()=>true,stop:async()=>{}})});
 try{
  await keeper.setAgent(true);assert.equal(reads,1);
  now=4000;await keeper.setAgent(false);assert.equal(reads,1);
  now=4999;await keeper.setAgent(true);assert.equal(reads,1);
  now=20000;await keeper.setAgent(false);assert.equal(reads,1);
  now=26000;await keeper.setAgent(true);assert.equal(reads,2);
  now=27000;await keeper.background('task',true);assert.equal(reads,2);
 }finally{await keeper.shutdown();}
});
test('active work re-reads power every 30 seconds while the watchdog checks the helper every 2',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 let reads=0,starts=0,alive=false;const states:boolean[]=[];
 const idle=async(ms:number)=>{for(let elapsed=0;elapsed<ms;elapsed+=1000){t.mock.timers.tick(1000);await new Promise<void>(resolve=>setImmediate(resolve));}};
 const keeper=new PowerKeeper({power:async()=>{reads++;return 'ac';},onChange:awake=>states.push(awake),
  start:()=>{starts++;alive=true;return {alive:()=>alive,stop:async()=>{alive=false;}};}});
 try{
  keeper.start();await keeper.setAgent(true);assert.equal(reads,1);assert.equal(starts,1);
  await idle(28000);assert.equal(reads,1,'watchdog ticks reuse a fresh reading');
  await idle(4000);assert.equal(reads,2,'and re-read it once it is 30 seconds old');
  alive=false;await idle(2000);assert.deepEqual(states,[true,false],'the next tick notices a dead helper');assert.equal(reads,2);
  await idle(30000);assert.equal(starts,2,'and the helper restarts after its backoff');assert.equal(reads,3);
 }finally{await keeper.shutdown();}
});
test('a failing helper cleanup never rejects a queued check or skips the next one',async()=>{
 let reads=0,broken=false;
 const keeper=new PowerKeeper({power:async()=>{reads++;return 'ac';},start:()=>({
  alive:()=>{if(broken)throw new Error('helper vanished');return true;},stop:async()=>{if(broken)throw new Error('stop failed');}})});
 try{
  await keeper.setAgent(true);broken=true;
  await assert.doesNotReject(keeper.check());assert.equal(reads,2);
  broken=false;await keeper.check();assert.equal(reads,3);
 }finally{broken=false;await keeper.shutdown();}
});

import { createEventBus } from '@earendil-works/pi-coding-agent';
import autoCaffeinate from './index.ts';
const wired=(power:'ac'|'battery'|NonNullable<KeeperOptions['power']>,start:KeeperOptions['start']=()=>({alive:()=>true,stop:async()=>{}}))=>{
 const handlers=new Map<string,any>();const status:(string|undefined)[]=[];const bus=createEventBus();
 autoCaffeinate({on:(name:string,handler:any)=>handlers.set(name,handler),events:bus} as any,{power:typeof power==='function'?power:async()=>power,start});
 const ctx={hasUI:true,ui:{setStatus:(_key:string,text?:string)=>status.push(text)}};
 return {status,bus,fire:(name:string)=>handlers.get(name)({},ctx),settle:()=>new Promise<void>(resolve=>setImmediate(resolve))};
};
test('a background task announced on the event bus keeps the machine awake and says so in the status bar',async()=>{
 const h=wired('ac');
 await h.fire('session_start');
 try{
  h.bus.emit('pi-interactive:background-activity',{id:'sub-1',active:true});await h.settle();
  assert.deepEqual(h.status,['☕ Awake']);
  h.bus.emit('pi-interactive:background-activity',{id:'sub-1',active:false});
 }finally{await h.fire('session_shutdown');}
 assert.equal(h.status.at(-1),undefined);
});
test('agent turns on battery never show the machine as held awake',async()=>{
 const h=wired('battery');
 await h.fire('session_start');
 try{await h.fire('agent_start');await h.settle();await h.fire('agent_settled');await h.settle();assert.deepEqual(h.status,[]);}
 finally{await h.fire('session_shutdown');}
});
test('agent events never wait for a power probe, while shutdown waits and starts nothing afterwards',async()=>{
 let finish=(_power:'ac')=>{};let starts=0;
 const h=wired(()=>new Promise(resolve=>{finish=resolve;}),()=>{starts++;return {alive:()=>true,stop:async()=>{}};});
 const blocked=Symbol('blocked');const outcome=(result:unknown)=>Promise.race([Promise.resolve(result),h.settle().then(()=>blocked)]);
 await h.fire('session_start');
 assert.notEqual(await outcome(h.fire('agent_start')),blocked);
 assert.notEqual(await outcome(h.fire('agent_settled')),blocked);
 const shutdown=h.fire('session_shutdown');assert.equal(await outcome(shutdown),blocked);
 finish('ac');await shutdown;assert.equal(starts,0);assert.deepEqual(h.status,[]);
});

test('a helper that fails to spawn never shows Awake in the status bar',{timeout:5000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-inhibitor-missing-'));
 let child:ReturnType<typeof spawn>|undefined;let failed:Promise<Error>|undefined;
 const launch:typeof spawn=((_command:string,_args:readonly string[],options:Parameters<typeof spawn>[2])=>{
  const launched=spawn(join(dir,'missing-helper'),[],options);child=launched;
  failed=new Promise(resolve=>launched.once('error',resolve));
  return launched;
 }) as typeof spawn;
 const h=wired('ac',changed=>startInhibitor('linux',launch,changed,async()=>[]));
 try{
  await h.fire('session_start');await h.fire('agent_start');await h.settle();
  assert.ok(child);assert.ok(failed);
  assert.equal(child.pid,undefined);
  assert.deepEqual(h.status,[]);
  const error=await failed;
  assert.equal('code' in error?error.code:undefined,'ENOENT');
  assert.deepEqual(h.status,[]);
 }finally{
  await h.fire('session_shutdown');await rm(dir,{recursive:true,force:true});
 }
});
