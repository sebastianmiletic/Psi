import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {readJSON,withLock} from '../src/storage.mjs';
import {runAutomaticStorage,launchAutomaticStorage,AutomaticStorage,STORAGE_RETRY} from '../src/automatic-storage.mjs';
import {MemoryTerminal} from './terminal.mjs';
const report={sessions:1,skipped:[],beforeBytes:100,afterBytes:20};
async function until(check){const end=Date.now()+15000;while(!await check()&&Date.now()<end)await delay(20);assert.ok(await check());}

test('automatic maintenance is throttled, excludes the running chat, and targets a chat once it closes',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.app.home,calls=[];let now=1000;
 const compact=async(home,options)=>{calls.push(options);return{...report,skipped:options.exclude};};
 await runAutomaticStorage(home,{sessionId:'active',now:()=>now,compact});assert.deepEqual(calls,[{only:null,exclude:['active']}]);
 assert.deepEqual(await runAutomaticStorage(home,{sessionId:'active',now:()=>now,compact}),{skipped:true});assert.equal(calls.length,1);
 now=2000;await runAutomaticStorage(home,{reason:'closed',sessionId:'active',requestedAt:1500,now:()=>now,compact});assert.deepEqual(calls[1],{only:['active'],exclude:[]});
 assert.equal((await readJSON(join(home,'automatic-storage.json'))).nextRunAt,1000+STORAGE_RETRY);
 assert.equal(f.requests.length,0);
});

test('background sweep ownership is exclusive and maintenance errors are retried without reaching the chat',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.app.home;
 await withLock(join(home,'automatic-storage.lock'),async()=>{assert.deepEqual(await runAutomaticStorage(home),{skipped:true});});
 const outcome=await runAutomaticStorage(home,{now:()=>1000,compact:async()=>{throw Error('Disk temporarily unavailable');}});assert.match(outcome.error,/Disk temporarily unavailable/);
 const state=await readJSON(join(home,'automatic-storage.json'));assert.equal(state.nextRunAt,1000+STORAGE_RETRY);assert.equal(state.error.message,'Disk temporarily unavailable');assert.equal(f.requests.length,0);
});

test('startup and periodic scheduling never await maintenance work and close cancels its timer',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),calls=[];let tick,cleared=false,unref=false;
 const scheduler=new AutomaticStorage(f.app.home,{sessionId:()=>f.session.meta.id,launch:async(_,event)=>{calls.push(event);},setIntervalImpl:fn=>{tick=fn;return{unref(){unref=true;}};},clearIntervalImpl:()=>{cleared=true;}});
 scheduler.start();scheduler.start();await delay(0);assert.equal(calls.length,1);assert.equal(unref,true);tick();await delay(0);assert.equal(calls.length,2);await scheduler.close();assert.equal(cleared,true);assert.equal(calls.at(-1).reason,'closed');await scheduler.close();assert.equal(calls.length,3);
});

test('interactive startup and close automatically schedule cleanup after releasing the session lease',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),calls=[];
 f.app.storageMaintenance=new AutomaticStorage(f.app.home,{sessionId:()=>f.session.meta.id,launch:async(_,event)=>{calls.push({...event,locked:!!await stat(join(f.session.dir,'ui.lock')).catch(()=>null)});}});
 f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false,autoUpdate:false});await f.session.message({role:'user',content:'Keep the complete conversation',timestamp:1});
 await f.app.startUI();await until(()=>calls.length===1);assert.equal(calls[0].reason,'scheduled');assert.equal(calls[0].locked,true);
 await f.app.close();assert.equal(calls.at(-1).reason,'closed');assert.equal(calls.at(-1).locked,false);assert.equal(f.requests.length,0);
});

test('a real detached worker compacts idle legacy history and automatically revisits a closed chat',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.app.home,idle=await Session.create(f.root,home);
 const original=JSON.stringify({type:'message',message:{role:'user',content:'Lossless history Ψ. '.repeat(6000),timestamp:1},at:new Date().toISOString()})+'\n';
 await writeFile(join(idle.dir,'events.jsonl'),original);await f.session.message({role:'user',content:'Active chat',timestamp:1});await writeFile(join(f.session.dir,'ui.lock'),JSON.stringify({pid:process.pid}));
 const active=await readFile(join(f.session.dir,'events.jsonl'));
 assert.equal(await launchAutomaticStorage(home,{sessionId:f.session.meta.id}),true);
 await until(async()=>!!(await readJSON(join(home,'automatic-storage.json'),null))?.completedAt);
 assert.ok((await readdir(join(idle.dir,'history'))).some(n=>n.endsWith('.psi')));assert.deepEqual(await readFile(join(f.session.dir,'events.jsonl')),active);
 const loaded=await Session.load(idle.meta.id,home);assert.equal(loaded.messages[0].content,'Lossless history Ψ. '.repeat(6000));
 assert.equal(await launchAutomaticStorage(home,{sessionId:f.session.meta.id}),false);
 await unlink(join(f.session.dir,'ui.lock'));await writeFile(join(f.session.dir,'events.jsonl'),original);
 const requestedAt=Date.now();await launchAutomaticStorage(home,{reason:'closed',sessionId:f.session.meta.id,requestedAt});
 await until(async()=>{const state=await readJSON(join(home,'automatic-storage.json'),null);return state?.completedAt>=requestedAt&&!state.skipped.includes(f.session.meta.id);});
 await until(async()=>!await stat(join(home,'automatic-storage.lock')).catch(()=>null));
 assert.ok((await readdir(join(f.session.dir,'history'))).some(n=>n.endsWith('.psi')));assert.equal(f.requests.length,0);
});

test('opening a chat waits for its storage maintenance instead of reporting another terminal or losing history',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Resume this exact chat',timestamp:1});
 let release,ready;const gate=new Promise(r=>release=r),acquired=new Promise(r=>ready=r);t.after(()=>release());
 const maintenance=withLock(join(f.session.dir,'ui.lock'),()=>withLock(join(f.session.dir,'run.lock'),async()=>{ready();await gate;},{kind:'storage-maintenance'}),{kind:'storage-maintenance'});await acquired;
 const {startupSession}=await import('../src/startup.mjs');let settled=false;
 const opening=startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true}).then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});
 await delay(30);assert.equal(settled,false);release();await maintenance;const result=await opening;assert.equal(result.error,undefined);assert.equal(result.value.meta.id,f.session.meta.id);assert.equal(result.value.messages[0].content,'Resume this exact chat');await result.value.uiLease.release();
});

test('normal print-mode CLI performs automatic cleanup without any storage command',async t=>{
 const f=await fixture(t,()=>({text:'Completed local fixture.'})),home=f.app.home,idle=await Session.create(f.root,home);
 await writeFile(join(home,'config.json'),JSON.stringify(f.config));await writeFile(join(idle.dir,'events.jsonl'),JSON.stringify({type:'message',message:{role:'user',content:'Retain all saved evidence. '.repeat(2000),timestamp:1},at:new Date().toISOString()})+'\n');
 const cli=fileURLToPath(new URL('../bin/psi.mjs',import.meta.url));const child=spawn(process.execPath,[cli,'-C',f.root,'--new','-p','Answer briefly.','--json'],{env:{...process.env,PSI_HOME:home},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);
 const code=await new Promise((accept,reject)=>{child.once('exit',accept);child.once('error',reject);});assert.equal(code,0,error);
 await until(async()=>{const state=await readJSON(join(home,'automatic-storage.json'),null);return state?.lastReason==='closed'&&!await stat(join(home,'automatic-storage.lock')).catch(()=>null);});
 assert.ok((await readdir(join(idle.dir,'history'))).some(n=>n.endsWith('.psi')));assert.equal(f.requests.length,1);
});
