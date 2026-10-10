import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
export type Power='ac'|'battery'|'unknown';
const MAINS=new Set(['Mains','USB','USB_C','USB_PD','USB_PD_DRP','Wireless']);
let mainsRoot:string|undefined,mainsKey='',mainsOnline:string[]=[],mainsFixed=false;
const readTrimmed=async(path:string):Promise<string|undefined>=>{
 try{return (await readFile(path,'utf8')).trim();}catch{return undefined;}
};
export async function readPower(platform=process.platform,root='/sys/class/power_supply'):Promise<Power>{
 try{
  if(platform==='darwin'){
   const {stdout}=await promisify(execFile)('/usr/bin/pmset',['-g','batt'],{timeout:2000,maxBuffer:16384});
   return /Now drawing from 'AC Power'/.test(stdout)?'ac':/Now drawing from 'Battery Power'/.test(stdout)?'battery':'unknown';
  }
  if(platform!=='linux')return 'unknown';
  const entries=await readdir(root);
  const key=entries.join('\0');
  let online=mainsOnline,fixed=mainsFixed;
  if(root!==mainsRoot||key!==mainsKey){
   online=[];fixed=true;let complete=true;
   for(const entry of entries){
    // Peripheral batteries, such as wireless mice, report Device scope and never power the system.
    if(await readTrimmed(join(root,entry,'scope'))==='Device')continue;
    fixed=false;
    const type=await readTrimmed(join(root,entry,'type'));
    if(type===undefined)complete=false;else if(MAINS.has(type))online.push(join(root,entry,'online'));
   }
   // A hotplugged supply can be listed before its attributes exist; rescan until they do.
   if(complete){mainsRoot=root;mainsKey=key;mainsOnline=online;mainsFixed=fixed;}
  }
  // Fixed-power desktops commonly expose no system power supplies at all.
  if(fixed)return 'ac';
  let offline=false;
  for(const path of online){
   const state=await readTrimmed(path);
   if(state==='1'||state==='2'||state==='3')return 'ac';if(state==='0')offline=true;
  }
  return offline?'battery':'unknown';
 }catch{return 'unknown';}
}
// systemd 257 added --no-ask-password; older systemd-inhibit rejects it and never asks for authorization.
export const inhibitFlags=(help:()=>Promise<{stdout:string}>)=>help().then(({stdout})=>stdout.includes('--no-ask-password')?['--no-ask-password']:[]);
let systemdFlags:Promise<string[]>|undefined;
// A failed check fails this start and is retried with the helper instead of guessing the flag.
const detectFlags=()=>systemdFlags??=inhibitFlags(()=>promisify(execFile)('systemd-inhibit',['--help'],{timeout:2000,maxBuffer:65536})).catch(error=>{systemdFlags=undefined;throw error;});
export interface Inhibitor {stop():Promise<void>;alive():boolean;held?():boolean}
export async function startInhibitor(platform:NodeJS.Platform=process.platform,launch=spawn,changed=()=>{},flags=detectFlags):Promise<Inhibitor|undefined> {
 let child:ChildProcess;
 if(platform==='darwin')child=launch('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:['pipe','ignore','ignore']});
 else if(platform==='linux')child=launch('systemd-inhibit',['--what=idle','--mode=block','--who=Pi','--why=Agent work',...await flags(),'/bin/cat'],{stdio:['pipe','pipe','ignore']});
 else return undefined;
 let running=child.pid!==undefined,held=running&&platform==='darwin';
 const ended=()=>{running=false;held=false;changed();};
 child.once('error',ended);child.once('exit',ended);
 // systemd-inhibit runs cat only once it holds the lock, so cat echoing a line confirms inhibition.
 child.stdin?.on('error',()=>{});child.stdout?.once('data',()=>{held=running;changed();});
 if(platform==='linux')child.stdin?.write('\n');
 return {alive:()=>running,held:()=>held,stop:async()=>{
  if(!running)return;
  const exited=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
  child.stdin?.end();if(platform==='darwin')child.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},1000);})]);
  if(running)await exited;
  if(timer)clearTimeout(timer);
 }};
}
export interface KeeperOptions {power?:()=>Promise<Power>;start?:(changed:()=>void)=>Inhibitor|undefined|Promise<Inhibitor|undefined>;now?:()=>number;lingerMs?:number;checkMs?:number;powerCacheMs?:number;powerPollMs?:number;onChange?:(awake:boolean)=>void}
export class PowerKeeper {
 private agent=false;private tasks=new Set<string>();private until=0;private stopped=false;private inhibitor?:Inhibitor;
 private cachedPower:Power='unknown';private checkedAt=-Infinity;private retryAt=0;
 private timer?:ReturnType<typeof setInterval>;private queue:Promise<void>=Promise.resolve();
 private awake=false;private watching=false;
 private publish(){const awake=!!this.inhibitor&&(this.inhibitor.held?.()??this.inhibitor.alive());if(awake!==this.awake){this.awake=awake;try{this.options.onChange(awake);}catch{return;}}}
 private readonly options:Required<KeeperOptions>;
 constructor(options:KeeperOptions={}){this.options={power:readPower,start:changed=>startInhibitor(process.platform,spawn,changed),now:Date.now,lingerMs:5000,checkMs:2000,powerCacheMs:5000,powerPollMs:30000,onChange:()=>{},...options};}
 private active(){return this.agent||this.tasks.size>0;}
 start(){if(!this.stopped){this.watching=true;this.arm();}}
 private arm(){
  const needed=this.watching&&!this.stopped&&(this.active()||this.until>this.options.now());
  if(needed){if(!this.timer){this.timer=setInterval(()=>{void this.check(this.options.powerPollMs);},this.options.checkMs);this.timer.unref();}}
  else if(this.timer){clearInterval(this.timer);this.timer=undefined;}
 }
 private async transition(mutate:()=>void){
  if(this.stopped)return;
  const before=this.active();
  mutate();
  if(before&&!this.active())this.until=this.options.now()+this.options.lingerMs;
  await this.check(!before&&this.active()?this.options.powerCacheMs:this.options.powerPollMs);
 }
 setAgent(active:boolean){return this.transition(()=>{this.agent=active;});}
 background(id:string,active:boolean){return this.transition(()=>{if(active)this.tasks.add(id);else this.tasks.delete(id);});}
 check(maxAge=0):Promise<void>{
  this.queue=this.queue.then(async()=>{
   if(this.stopped)return;
   const needed=this.active()||this.until>this.options.now();
   if(needed&&this.options.now()-this.checkedAt>=maxAge){this.cachedPower=await this.options.power().catch(()=>'unknown' as const);this.checkedAt=this.options.now();}
   const power=needed?this.cachedPower:'unknown';
   if(this.stopped)return;
   if(!needed||power!=='ac'){await this.release();return;}
   if(this.inhibitor&&!this.inhibitor.alive()){this.inhibitor=undefined;this.retryAt=this.options.now()+30000;}
   if(!this.inhibitor&&this.options.now()>=this.retryAt){try{this.inhibitor=await this.options.start(()=>this.publish());}catch{this.inhibitor=undefined;}if(!this.inhibitor)this.retryAt=this.options.now()+30000;}
  }).catch(async(_error:unknown)=>{await this.release();}).finally(()=>{this.publish();this.arm();}).catch(()=>{});return this.queue;
 }
 private async release(){const current=this.inhibitor;this.inhibitor=undefined;try{await current?.stop();}finally{this.publish();}}
 async shutdown(){this.stopped=true;this.watching=false;if(this.timer){clearInterval(this.timer);this.timer=undefined;}await this.queue;await this.release();this.tasks.clear();}
}
