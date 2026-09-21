import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PowerKeeper, type KeeperOptions } from './power.ts';
/** `keeperOptions` replaces the power and inhibitor adapters; Pi passes none, tests pass fakes. */
export default function autoCaffeinate(pi:ExtensionAPI,keeperOptions:Pick<KeeperOptions,'power'|'start'>={}):void {
 let ctx:ExtensionContext|undefined;
 const keeper=new PowerKeeper({...keeperOptions,onChange:awake=>{
  if(ctx?.hasUI)ctx.ui.setStatus('auto-caffeinate',awake?'☕ Awake':undefined);
 }});
 pi.on('session_start',(_event,context)=>{ctx=context;keeper.start();});
 pi.on('agent_start',()=>keeper.setAgent(true));
 pi.on('agent_settled',()=>keeper.setAgent(false));
 const unsubscribe=pi.events.on('pi-interactive:background-activity',(value:unknown)=>{
  if(!value||typeof value!=='object')return;
  const event=value as {id?:unknown;active?:unknown};
  if(typeof event.id==='string'&&typeof event.active==='boolean')void keeper.background(event.id,event.active);
 });
 pi.on('session_shutdown',async()=>{unsubscribe();await keeper.shutdown();});
}
