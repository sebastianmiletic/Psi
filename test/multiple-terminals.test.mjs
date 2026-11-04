import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fixture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {App} from '../src/app.mjs';
import {startupSession} from '../src/startup.mjs';
import {sessionInUse,claimSessionUI} from '../src/session-lease.mjs';
import {withLock} from '../src/storage.mjs';
import {MemoryTerminal} from './terminal.mjs';
async function saved(t){const f=await fixture(t,()=>({text:'Verified independent result.'}));await f.session.message({role:'user',content:'Saved analysis',timestamp:Date.now()});return f;}

test('a live inference lock starts an independent implicit chat without changing the busy journal',async t=>{
 const f=await saved(t);let ready,release;const acquired=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const lock=withLock(join(f.session.dir,'run.lock'),async()=>{ready();await gate;});await acquired;t.after(()=>release());
 const before=await readFile(join(f.session.dir,'events.jsonl'),'utf8');
 const other=await startupSession({home:f.app.home,cwd:f.root,interactive:true});assert.notEqual(other.meta.id,f.session.meta.id);assert.equal(other.messages.length,0);
 assert.equal(await readFile(join(f.session.dir,'events.jsonl'),'utf8'),before);
 await assert.rejects(startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true}),/another terminal.*psi --new/);
 release();await lock;const resumed=await startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true});assert.equal(resumed.meta.id,f.session.meta.id);await resumed.uiLease.release();await other.discardEmpty();
});

test('two interactive apps keep separate directories, prompts and durable journals',async t=>{
 const f=await saved(t);await f.app.update({checkForUpdates:false,autoUpdate:false});f.app.options.terminal=new MemoryTerminal(100,32);await f.app.startUI();
 const otherRoot=join(f.root,'other');await mkdir(otherRoot);
 const s=await startupSession({home:f.app.home,cwd:otherRoot,interactive:true}),second=new App({...f.config,checkForUpdates:false,autoUpdate:false},s,{home:f.app.home,terminal:new MemoryTerminal(100,32)});t.after(()=>second.close());await second.startUI();
 assert.notEqual(second.session.meta.id,f.session.meta.id);assert.equal(second.session.meta.cwd,otherRoot);
 await Promise.all([f.app.submit('First terminal task'),second.submit('Second terminal task')]);
 assert.ok(f.session.messages.some(m=>m.content==='First terminal task'));assert.ok(!f.session.messages.some(m=>m.content==='Second terminal task'));
 assert.ok(second.session.messages.some(m=>m.content==='Second terminal task'));assert.ok(!second.session.messages.some(m=>m.content==='First terminal task'));
 assert.equal(f.session.totals.requests,1);assert.equal(second.session.totals.requests,1);assert.equal((await Session.list(f.app.home)).length,2);
 await second.close();assert.equal(await sessionInUse(second.session.meta.id,f.app.home),false);assert.equal(await sessionInUse(f.session.meta.id,f.app.home),true);
});

test('simultaneous implicit startups both create fresh chats and leave saved history untouched',async t=>{
 const f=await saved(t);const sessions=await Promise.all([startupSession({home:f.app.home,cwd:f.root,interactive:true}),startupSession({home:f.app.home,cwd:f.root,interactive:true})]);
 assert.equal(new Set(sessions.map(s=>s.meta.id)).size,2);assert.equal(sessions.filter(s=>s.meta.id===f.session.meta.id).length,0);assert.ok(sessions.every(s=>s.messages.length===0));assert.deepEqual((await Session.list(f.app.home)).map(s=>s.id),[f.session.meta.id]);
 for(const s of sessions){await s.uiLease?.release();if(s.meta.id!==f.session.meta.id)await s.discardEmpty();}
});

test('a crashed terminal lease is recovered without losing the saved conversation',async t=>{
 const f=await saved(t),module=new URL('../src/session-lease.mjs',import.meta.url).href;
 const code=`import {claimSessionUI} from ${JSON.stringify(module)};import{writeSync}from'node:fs';await claimSessionUI({dir:${JSON.stringify(f.session.dir)},meta:{id:${JSON.stringify(f.session.meta.id)}}});writeSync(1,'held');process.kill(process.pid,'SIGKILL');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});assert.equal(child.stdout,'held');
 const resumed=await startupSession({home:f.app.home,cwd:f.root,resume:f.session.meta.id,interactive:true});assert.equal(resumed.meta.id,f.session.meta.id);assert.equal(resumed.messages[0].content,'Saved analysis');await resumed.uiLease.release();
});

test('new-chat switching and reload transfer ownership, and active empty chats cannot be discarded',async t=>{
 const f=await saved(t);await f.app.update({checkForUpdates:false});f.app.options.terminal=new MemoryTerminal(100,32);await f.app.startUI();
 const original=f.session.meta.id;await f.app.submit('/new');const empty=f.app.session;
 assert.equal(await sessionInUse(original,f.app.home),false);assert.equal(await empty.discardEmpty(),false);assert.ok(await stat(join(empty.dir,'meta.json')));
 await f.app.changeSession(await Session.load(original,f.app.home));assert.equal(await stat(join(empty.dir,'meta.json')).catch(()=>null),null);assert.equal(await sessionInUse(original,f.app.home),true);
 await f.app.reload();assert.equal(await sessionInUse(original,f.app.home),true);await f.app.close();assert.equal(await sessionInUse(original,f.app.home),false);
});
