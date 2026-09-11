import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoPolicy, assertChildTask, setActivePolicy } from './policy.ts';

test('workspace reads and edits pass without a model; symlink escapes require approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-policy-'));
  try {
    await mkdir(join(root, 'workspace'));
    await symlink(root, join(root, 'workspace', 'escape'));
    const policy = new AutoPolicy(join(root, 'workspace'));
    assert.equal((await policy.check({tool:'write', input:{path:'new/file', content:'hi'}, cwd:policy.root})).allow, true);
    assert.equal((await policy.check({tool:'read', input:{path:'escape/secret'}, cwd:policy.root})).allow, false);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('classifier errors, invalid verdicts, shell composition and missing UI fail closed', async () => {
  const policy = new AutoPolicy(tmpdir());
  const action={tool:'bash',input:{command:'pwd; touch /tmp/unapproved'},cwd:tmpdir()};
  assert.equal((await policy.check(action,{classify:async()=>{throw Error('offline');},approve:async()=>true})).allow,false);
  assert.equal((await policy.check(action,{classify:async()=>'safe'})).allow,false);
  assert.equal((await policy.check(action,{approve:async()=>{throw Error('UI gone');}})).allow,false);
  assert.equal((await policy.check(action,{context:'before tool output',approve:async()=>true})).allow,true);
  assert.equal((await policy.check(action,{context:'new tool output changes bounded conversation'})).allow,true);
  assert.equal((await policy.check(action)).allow,true);
  assert.equal((await policy.check({...action,input:{command:'pwd; touch /tmp/different'}})).allow,false);
  policy.directive('Only inspect files');
  assert.equal((await policy.check(action)).allow,false);
});

test('inherited policy cannot disable itself, escape workspace, or trust MCP metadata',async()=>{
  const policy=new AutoPolicy(tmpdir(),['read'],true);
  policy.mode='off';
  assert.equal((await policy.check({tool:'bash',input:{command:'pwd'},cwd:tmpdir()},{approve:async()=>true})).allow,false);
  assert.equal((await policy.check({tool:'read',input:{path:'/etc/passwd'},cwd:tmpdir()},{approve:async()=>true})).allow,false);
  assert.throws(()=>policy.declare({version:1,source:'remote',extension:'/tmp/mcp',tool:'remote',effect:'read',pathArgument:'path'} as any));
});

test('trusted local declarations enable bounded custom file tools without trusting remote hints',async()=>{
  const policy=new AutoPolicy(tmpdir());
  const action={tool:'local_read',input:{file:'test.txt'},cwd:tmpdir()};
  assert.equal((await policy.check(action)).allow,false);
  policy.declare({version:1,source:'local',extension:'/trusted/local-extension.ts',tool:'local_read',effect:'read',pathArgument:'file'});
  assert.equal((await policy.check(action)).allow,true);
  assert.equal((await policy.check({...action,input:{file:'/etc/passwd'}})).allow,false);
  assert.equal(new AutoPolicy(tmpdir()).tools.includes('local_read'),false);
});

test('credential filenames and invalid file arguments never gain deterministic or classifier-only approval',async()=>{
  const policy=new AutoPolicy(tmpdir());
  for(const path of ['.env','.env.production','auth.json','credentials.json','id_rsa']) {
    assert.equal((await policy.check({tool:'read',input:{path},cwd:tmpdir()},{classify:async()=>'safe'})).allow,false,path);
  }
  assert.equal((await policy.check({tool:'read',input:{},cwd:tmpdir()},{classify:async()=>'safe',approve:async()=>true})).allow,false);
});

test('Pi home, at-prefix and file URL paths cannot bypass workspace checks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'auto-expand-'));
  try {
    const parent=new AutoPolicy(root), child=new AutoPolicy(root,['read'],true);
    for(const path of ['~','~/outside-secret','@~/outside-secret','@/etc/passwd','file:///etc/passwd']) {
      assert.equal((await parent.check({tool:'read',input:{path},cwd:root})).allow,false,path);
      assert.equal((await parent.check({tool:'read',input:{path},cwd:root},{approve:async()=>true})).allow,true,path);
      assert.equal((await child.check({tool:'read',input:{path},cwd:root},{approve:async()=>true})).allow,false,path);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Pi read filename fallbacks cannot hide an escaping symlink',async()=>{
  const root=await mkdtemp(join(tmpdir(),'auto-fallback-'));
  const outside=await mkdtemp(join(tmpdir(),'auto-outside-'));
  try {
    await symlink(outside,join(root,'Capture d’écran'));
    const policy=new AutoPolicy(root,['read'],true);
    assert.equal((await policy.check({tool:'read',input:{path:"Capture d'écran"},cwd:root})).allow,false);
  } finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('directory grep requires approval because hidden credential files are searched',async()=>{
  const {writeFile}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'auto-grep-'));
  try {
    await writeFile(join(root,'auth.json'),'{"token":"synthetic"}');
    await writeFile(join(root,'safe.txt'),'ordinary text');
    const parent=new AutoPolicy(root), child=new AutoPolicy(root,['grep'],true);
    const directory={tool:'grep',input:{pattern:'token',path:'.'},cwd:root};
    assert.equal((await parent.check(directory,{classify:async()=>'safe'})).allow,false);
    assert.equal((await parent.check(directory,{approve:async()=>true})).allow,true);
    assert.equal((await child.check(directory)).allow,false);
    assert.equal((await child.check({tool:'grep',input:{pattern:'token'},cwd:root})).allow,false);
    assert.equal((await child.check({tool:'grep',input:{pattern:'ordinary',path:'safe.txt'},cwd:root})).allow,true);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('child cwd narrowing cannot erase a sensitive parent directory component',async()=>{
  const {writeFile}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'auto-sensitive-cwd-'));
  try {
    await mkdir(join(root,'credentials'));
    await writeFile(join(root,'credentials','note.txt'),'synthetic secret');
    setActivePolicy(new AutoPolicy(root),'sensitive-cwd');
    await assert.rejects(assertChildTask({cwd:join(root,'credentials'),tools:['read']},{},'sensitive-cwd'),/sensitive|control/);
  } finally {setActivePolicy(undefined,'sensitive-cwd');await rm(root,{recursive:true,force:true});}
});

test('managed local declarations retain workspace and inherited tool boundaries',async()=>{
  const action={tool:'memory',input:{action:'read',name:'note'},cwd:tmpdir()};
  const declaration={version:1,source:'local',extension:'/trusted/memory/index.ts',tool:'memory',effect:'managed'} as const;
  const policy=new AutoPolicy(tmpdir());
  assert.equal((await policy.check(action)).allow,false);
  policy.declare(declaration);
  assert.equal((await policy.check(action)).allow,true);
  assert.equal((await policy.check({...action,cwd:'/etc'})).allow,false);
  assert.throws(()=>new AutoPolicy(tmpdir(),['read'],true).declare(declaration),/inherited/);
  assert.throws(()=>policy.declare({...declaration,source:'remote'} as any),/trusted local/);
  assert.throws(()=>policy.declare({...declaration,pathArgument:'path'} as any),/trusted local/);
  const child=new AutoPolicy(tmpdir(),['memory'],true);
  child.declare(declaration);
  assert.equal((await child.check(action)).allow,true);
  assert.equal((await child.check({...action,cwd:'/etc'},{approve:async()=>true})).allow,false);
});
