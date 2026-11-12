import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,utimes,stat,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './helpers.mjs';
import {startupSession} from '../src/startup.mjs';
import {sessionInUse} from '../src/session-lease.mjs';
import {inspectLock,withLock,LOCK_WRITE_GRACE} from '../src/storage.mjs';
import {processIdentity} from '../src/process-identity.mjs';
import {CommandAutocomplete,commands} from '../src/ui.mjs';

async function saved(t){const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Keep this conversation',timestamp:Date.now()});await f.session.saveDraft('Keep this draft');return f;}
async function stale(path,text){await writeFile(path,text);const old=new Date(Date.now()-LOCK_WRITE_GRACE-5000);await utimes(path,old,old);}

test('reused live PID locks recover without changing the saved conversation or draft',async t=>{
 const f=await saved(t),before=await readFile(join(f.session.dir,'events.jsonl'));
 for(const name of ['ui.lock','run.lock'])await writeFile(join(f.session.dir,name),JSON.stringify({pid:process.pid,processKey:'previous process using this PID'}));
 assert.equal(await sessionInUse(f.session.meta.id,f.app.home),false);
 const resumed=await startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true});
 try{assert.equal(resumed.messages[0].content,'Keep this conversation');assert.equal(await resumed.getDraft(),'Keep this draft');assert.deepEqual(await readFile(join(f.session.dir,'events.jsonl')),before);assert.equal(await sessionInUse(f.session.meta.id,f.app.home),true);}
 finally{await resumed.uiLease.release();}
 assert.equal(f.requests.length,0);
});

test('legacy PID-only locks older than the current process are reclaimed',async t=>{
 const f=await saved(t),identity=await processIdentity(process.pid);assert.ok(identity?.startedAt);
 for(const name of ['ui.lock','run.lock']){const path=join(f.session.dir,name);await writeFile(path,JSON.stringify({pid:process.pid}));const old=new Date(identity.startedAt-5000);await utimes(path,old,old);}
 assert.equal(await sessionInUse(f.session.meta.id,f.app.home),false);
 const s=await startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true});await s.uiLease.release();
});

test('old empty, malformed and ownerless locks recover; fresh incomplete locks remain protected',async t=>{
 const f=await saved(t);
 for(const text of ['', '{"pid":', '{}', '{"pid":-1}']){
  for(const name of ['ui.lock','run.lock'])await stale(join(f.session.dir,name),text);
  assert.equal(await sessionInUse(f.session.meta.id,f.app.home),false);
  const s=await startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true});await s.uiLease.release();
 }
 const path=join(f.session.dir,'ui.lock');await writeFile(path,'');assert.equal(await sessionInUse(f.session.meta.id,f.app.home),true);
 await assert.rejects(startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true}),/another terminal/);
 await assert.rejects(withLock(path,()=>assert.fail('must not enter'),{timeout:0}),/Another Psi process/);
 await rm(path);
});

test('concurrent stale-lock recovery admits exactly one terminal and retains its lease',async t=>{
 const f=await saved(t);for(const name of ['ui.lock','run.lock'])await stale(join(f.session.dir,name),'');
 const results=await Promise.allSettled(Array.from({length:5},()=>startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true})));
 const winners=results.filter(r=>r.status==='fulfilled');
 try{assert.equal(winners.length,1);assert.equal(results.filter(r=>r.status==='rejected').length,4);assert.equal(await sessionInUse(f.session.meta.id,f.app.home),true);}
 finally{for(const r of winners)await r.value.uiLease.release();}
});

test('an old but genuinely live owner stays locked and release cannot remove a replacement',async t=>{
 const f=await saved(t),path=join(f.session.dir,'ui.lock');
 await withLock(path,async()=>{
  const owner=JSON.parse(await readFile(path));assert.ok(owner.token);assert.ok(owner.processKey);
  const old=new Date(Date.now()-86400000);await utimes(path,old,old);
  assert.equal((await inspectLock(path)).stale,false);assert.equal(await sessionInUse(f.session.meta.id,f.app.home),true);
  await assert.rejects(withLock(path,()=>assert.fail('must not enter'),{timeout:0}),/Another Psi process/);
  await writeFile(path,JSON.stringify({...owner,token:'replacement-owner'}));
 });
 assert.equal(JSON.parse(await readFile(path)).token,'replacement-owner');await rm(path);
});

test('a real separate-process owner is protected, then its crash releases the chat for recovery',{timeout:20000},async t=>{
 const f=await saved(t),module=new URL('../src/session-lease.mjs',import.meta.url).href;
 const code=`import {claimSessionUI} from ${JSON.stringify(module)};await claimSessionUI({dir:${JSON.stringify(f.session.dir)},meta:{id:${JSON.stringify(f.session.meta.id)}}});console.log('held');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',b=>err+=b);
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 let ready=false;child.stdout.on('data',b=>{if(String(b).includes('held'))ready=true;});
 for(let i=0;i<250&&!ready&&child.exitCode===null;i++)await delay(20);assert.ok(ready,err);
 assert.equal(await sessionInUse(f.session.meta.id,f.app.home),true);
 await assert.rejects(startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true}),/another terminal/);
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 const s=await startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true});await s.uiLease.release();
});

test('separate processes competing to recover a stale lock never overlap',{timeout:20000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'psi-lock-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'run.lock');await stale(path,'');
 const module=new URL('../src/storage.mjs',import.meta.url).href;
 const code=`import {withLock} from ${JSON.stringify(module)};import{open,unlink}from'node:fs/promises';await withLock(${JSON.stringify(path)},async()=>{const sentinel=await open(${JSON.stringify(join(dir,'critical'))},'wx');await new Promise(r=>setTimeout(r,40));await sentinel.close();await unlink(${JSON.stringify(join(dir,'critical'))});},{timeout:10000});`;
 const children=Array.from({length:5},()=>spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']}));
 t.after(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');});
 const results=await Promise.all(children.map(async c=>{let err='';c.stderr.on('data',b=>err+=b);const [exit]=await once(c,'exit');return{exit,err};}));for(const r of results)assert.equal(r.exit,0,r.err);
 assert.equal(await stat(path).catch(()=>null),null);
});

test('resume precedes reset in commands and filtered autocomplete',async()=>{
 assert.ok(commands.findIndex(c=>c.name==='resume')<commands.findIndex(c=>c.name==='reset'));
 const provider=new CommandAutocomplete(process.cwd());
 for(const text of ['/','/r','/re','/res']){const result=await provider.getSuggestions([text],0,text.length,{signal:new AbortController().signal});const values=result.items.map(i=>i.value);assert.ok(values.indexOf('resume')<values.indexOf('reset'),text);}
 const exact=await provider.getSuggestions(['/reset'],0,6,{signal:new AbortController().signal});assert.equal(exact.items[0].value,'reset');
});

test('resuming the currently open chat does not reload its own active lock',async t=>{
 const f=await saved(t);f.app.ui={choose:async()=>f.session.meta.id};
 try{await withLock(join(f.session.dir,'run.lock'),async()=>{await f.app.submit('/resume');await f.app.submit('/resume '+f.session.meta.id);});assert.equal(f.requests.length,0);}
 finally{f.app.ui=null;}
});
