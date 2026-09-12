// No host objects or functions cross into the context. IPC carries JSON values.
// vm is defense in depth; approved source and the subprocess permission model
// remain necessary. This is not an OS sandbox.
import vm from 'node:vm';

const context = vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
let started = false;
let totalRequests = 0;
function evaluate(source) { return vm.runInContext(source, context, {timeout:100}); }
function pump() {
 const encoded = evaluate('JSON.stringify({requests: __requests.splice(0), result: __result})');
 if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) throw new Error('Workflow message exceeds 1 MiB limit');
 const state = JSON.parse(encoded);
 if (state.result && Buffer.byteLength(JSON.stringify(state.result), 'utf8') > 256 * 1024) throw new Error('Workflow result exceeds 256 KiB limit');
 for (const request of state.requests) {
  if (++totalRequests > 1000) throw new Error('Workflow capability limit reached');
  process.send?.({type:'request',...request});
 }
 if (state.result) {
  process.send?.({type:'done',...state.result},()=>process.exit(0));
 }
}
process.on('message', message => {
 try {
  if (message.type === 'start' && !started) {
   started = true;
   evaluate(`
    globalThis.__requests = []; globalThis.__result = null;
    globalThis.__pending = new Map(); let __sequence = 0;
    const request = (operation, args) => new Promise((resolve,reject)=>{
      const id = ++__sequence; __pending.set(id,{resolve,reject}); __requests.push({id,operation,args});
    });
    const checkpointKeys = new Set();
    const api = Object.freeze({
      spawn: (task, stage) => {
        if(typeof stage !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(stage)) throw new Error('spawn requires an explicit stable stage label');
        return request('spawn', {task,stage});
      },
      readFile: (path, maxBytes = 65536) => request('readFile', {path,maxBytes}),
      parallel: async (tasks) => {
        if (!Array.isArray(tasks) || tasks.length > 16) throw new Error('parallel accepts at most 16 functions');
        return await Promise.all(tasks.map(task => task()));
      },
      retry: async (attempts, task) => {
        if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('retry attempts must be 1–5');
        for (let i=0;i<attempts;i++) {try{return await task(i);}catch(error){if(error?.retryable === false || i+1===attempts)throw error;}}
      },
      checkpoint: async (key, task) => {
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) throw new Error('Invalid checkpoint key');
        if(checkpointKeys.has(key)) throw new Error('Concurrent duplicate checkpoint');
        checkpointKeys.add(key);
        try {
         const cached = await request('checkpointGet',{key});
         if(cached.found) return cached.value;
         const value = await task(); await request('checkpointPut',{key,value}); return value;
        } finally {checkpointKeys.delete(key);}
      }
    });
    Promise.resolve().then(async()=>{${message.code}\nreturn await workflow(api);}).then(
      value=>{__result={ok:true,value:value === undefined ? null : value};},
      error=>{__result={ok:false,error:String(error?.message ?? error)};}
    );
   `);
  } else if (message.type === 'response') {
   evaluate(`{ const response = JSON.parse(${JSON.stringify(JSON.stringify(message))}); const pending = __pending.get(response.id); if(pending) {__pending.delete(response.id); if(response.ok) pending.resolve(response.value); else pending.reject(Object.assign(new Error(response.error), {retryable: response.retryable !== false}));} }`);
  }
  pump();
 } catch(error) { process.send?.({type:'done',ok:false,error:String(error?.message ?? error)},()=>process.exit(1)); }
});
