import assert from 'node:assert/strict';
import test from 'node:test';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { MacDesktop } from './native.ts';

test('macOS JSON protocol preserves split Unicode and reports failed helper startup promptly', async () => {
 const original=cp.spawn;
 let missing=false;
 cp.spawn=((command:string,_args:unknown,options:unknown)=>{
  assert.equal(command,'/usr/bin/swift');
  if(missing)return original('/nonexistent-pi-swift-fixture',[],options as any);
  const script=`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const id=JSON.parse(line).id;const data=Buffer.from(JSON.stringify({id,ok:true,result:{text:'Unicode é title'}})+'\\n');const split=data.indexOf(Buffer.from('é'))+1;process.stdout.write(data.subarray(0,split));setTimeout(()=>process.stdout.write(data.subarray(split)),20);});`;
  return original(process.execPath,['-e',script],options as any);
 }) as typeof cp.spawn;
 syncBuiltinESMExports();
 const desktop=new MacDesktop();
 try {
  assert.equal((await desktop.run({action:'accessibility'},AbortSignal.timeout(2000))).text,'Unicode é title');
  await desktop.close();missing=true;
  const absent=new MacDesktop();
  try {await assert.rejects(absent.run({action:'accessibility'},AbortSignal.timeout(2000)),/Swift runtime unavailable/);}
  finally {await absent.close();}
 } finally {await desktop.close();cp.spawn=original;syncBuiltinESMExports();}
});
