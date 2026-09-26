import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
export type Power='ac'|'battery'|'unknown';
const MAINS=new Set(['Mains','USB','USB_C','USB_PD','USB_PD_DRP','Wireless']);
let mainsRoot:string|undefined,mainsKey='',mainsOnline:string[]=[];
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
  // Fixed-power desktops commonly expose no power-supply devices at all.
  if(entries.length===0)return 'ac';
  const key=entries.join('\0');
  let online=mainsOnline;
  if(root!==mainsRoot||key!==mainsKey){
   online=[];
   for(const entry of entries){
    const type=await readTrimmed(join(root,entry,'type'));
    if(type!==undefined&&MAINS.has(type))online.push(join(root,entry,'online'));
   }
   mainsRoot=root;mainsKey=key;mainsOnline=online;
  }
  let offline=false;
  for(const path of online){
   const state=await readTrimmed(path);
   if(state==='1')return 'ac';if(state==='0')offline=true;
  }
  return offline?'battery':'unknown';
 }catch{return 'unknown';}
}
export interface Inhibitor {stop():Promise<void>;alive():boolean}
export function startInhibitor(platform:NodeJS.Platform=process.platform,launch=spawn):Inhibitor|undefined {
 let child:ChildProcess;
 if(platform==='darwin')child=launch('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:['pipe','ignore','ignore']});
 else if(platform==='linux')child=launch('systemd-inhibit',['--what=idle','--mode=block','--who=Pi','--why=Agent work','--no-ask-password','/bin/cat'],{stdio:['pipe','ignore','ignore']});
 else return undefined;
 let running=true;
 child.once('error',()=>{running=false;});child.once('exit',()=>{running=false;});
 return {alive:()=>running,stop:async()=>{
  if(!running)return;
  const exited=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
  child.stdin?.end();if(platform==='darwin')child.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},1000);})]);
  if(running)await exited;
  if(timer)clearTimeout(timer);
 }};
}
export interface KeeperOptions {power?:()=>Promise<Power>;start?:()=>Inhibitor|undefined;now?:()=>number;lingerMs?:number;checkMs?:number;powerCacheMs?:number;onChange?:(awake:boolean)=>void}
export class PowerKeeper {
 private agent=false;private tasks=new Set<string>();private until=0;private stopped=false;private inhibitor?:Inhibitor;
 private cachedPower:Power='unknown';private checkedAt=-Infinity;private retryAt=0;
 private timer?:ReturnType<typeof setInterval>;private queue:Promise<void>=Promise.resolve();
 private awake=false;private watching=false;
 private publish(){const awake=!!this.inhibitor?.alive();if(awake!==this.awake){this.awake=awake;try{this.options.onChange(awake);}catch{return;}}}
 private readonly options:Required<KeeperOptions>;
 constructor(options:KeeperOptions={}){this.options={power:readPower,start:startInhibitor,now:Date.now,lingerMs:5000,checkMs:2000,powerCacheMs:1000,onChange:()=>{},...options};}
 private active(){return this.agent||this.tasks.size>0;}
 start(){if(!this.stopped){this.watching=true;this.arm();}}
 private arm(){
  const needed=this.watching&&!this.stopped&&(this.active()||this.until>this.options.now());
  if(needed){if(!this.timer){this.timer=setInterval(()=>{void this.check(false);},this.options.checkMs);this.timer.unref();}}
  else if(this.timer){clearInterval(this.timer);this.timer=undefined;}
 }
 private async transition(mutate:()=>void){
  if(this.stopped)return;
  const before=this.active();
  mutate();
  if(before&&!this.active())this.until=this.options.now()+this.options.lingerMs;
  await this.check(false);
 }
 setAgent(active:boolean){return this.transition(()=>{this.agent=active;});}
 background(id:string,active:boolean){return this.transition(()=>{if(active)this.tasks.add(id);else this.tasks.delete(id);});}
 check(force=true):Promise<void>{
  this.queue=this.queue.then(async()=>{
   if(this.stopped)return;
   const needed=this.active()||this.until>this.options.now();
   if(needed&&(force||this.options.now()-this.checkedAt>=this.options.powerCacheMs)){this.cachedPower=await this.options.power().catch(()=>'unknown' as const);this.checkedAt=this.options.now();}
   const power=needed?this.cachedPower:'unknown';
   if(this.stopped)return;
   if(!needed||power!=='ac'){await this.release();return;}
   if(this.inhibitor&&!this.inhibitor.alive()){this.inhibitor=undefined;this.retryAt=this.options.now()+30000;}
   if(!this.inhibitor&&this.options.now()>=this.retryAt){try{this.inhibitor=this.options.start();}catch{this.inhibitor=undefined;}if(!this.inhibitor)this.retryAt=this.options.now()+30000;}
  }).catch(async(_error:unknown)=>{await this.release();}).finally(()=>{this.publish();this.arm();});return this.queue;
 }
 private async release(){const current=this.inhibitor;this.inhibitor=undefined;try{await current?.stop();}finally{this.publish();}}
 async shutdown(){this.stopped=true;this.watching=false;if(this.timer){clearInterval(this.timer);this.timer=undefined;}await this.queue;await this.release();this.tasks.clear();}
}
