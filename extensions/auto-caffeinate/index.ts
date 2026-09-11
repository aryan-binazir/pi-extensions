import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PowerKeeper } from './power.ts';
export default function autoCaffeinate(pi:ExtensionAPI):void {
 const keeper=new PowerKeeper();
 pi.on('session_start',()=>keeper.start());
 pi.on('agent_start',()=>keeper.setAgent(true));
 pi.on('agent_settled',()=>keeper.setAgent(false));
 const unsubscribe=pi.events.on('pi-interactive:background-activity',(value:unknown)=>{
  if(!value||typeof value!=='object')return;
  const event=value as {id?:unknown;active?:unknown};
  if(typeof event.id==='string'&&typeof event.active==='boolean')void keeper.background(event.id,event.active);
 });
 pi.on('session_shutdown',async()=>{unsubscribe();await keeper.shutdown();});
}
