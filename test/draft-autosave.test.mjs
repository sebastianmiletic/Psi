import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {App} from '../src/app.mjs';
import {MemoryTerminal} from './terminal.mjs';
import {DraftAutosave} from '../src/draft-autosave.mjs';
async function setup(t){const f=await fixture(t,()=>({text:'Submitted answer.'}));f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false,autoUpdate:false,animations:false});await f.app.startUI();return{...f,ui:f.app.ui,terminal:f.app.ui.terminal};}
async function until(check){const end=Date.now()+8000;while(Date.now()<end){if(await check())return;await delay(10);}assert.fail('Draft was not saved');}
async function snapshot(session){return JSON.parse(await readFile(join(session.dir,'composer-draft.json'),'utf8'));}

test('typing saves an unnamed session live, and reopening restores the exact draft without submitting it',async t=>{
 const f=await setup(t),text='Unsent prompt 🧪 with all details';f.terminal.input(text);
 await until(async()=> (await snapshot(f.session).catch(()=>null))?.text===text);assert.equal(f.requests.length,0);assert.deepEqual(f.session.messages,[]);assert.equal((await Session.list(f.app.home))[0].id,f.session.meta.id);assert.equal(f.session.meta.named,undefined);
 await f.app.close();const session=await Session.load(f.session.meta.id,f.app.home),app=new App(f.config,session,{home:f.app.home,terminal:new MemoryTerminal(100,32)});await app.update({checkForUpdates:false});try{await app.startUI();assert.equal(app.ui.editor.getText(),text);assert.deepEqual(session.messages,[]);assert.equal(f.requests.length,0);}finally{await app.close();}
});

test('a process killed after a live draft save reopens with its multiline prompt and no message history',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),module=new URL('../src/session.mjs',import.meta.url).href,text='First line\nSecond line Ψ 🧪';
 const script=`import{Session}from ${JSON.stringify(module)};const s=await Session.create(${JSON.stringify(f.root)},${JSON.stringify(f.app.home)});await s.saveDraft(${JSON.stringify(text)});console.log(s.meta.id);process.kill(process.pid,'SIGKILL');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000}),id=child.stdout.trim();assert.ok(id);const loaded=await Session.load(id,f.app.home);assert.equal(await loaded.getDraft(),text);assert.equal(loaded.messages.length,0);assert.equal(await loaded.discardEmpty(),false);
});

test('each chat restores its own draft when switching and reload preserves unsent edits',async t=>{
 const f=await setup(t),first=f.app.session;f.terminal.input('First unsent draft');await f.app.submit('/new');const second=f.app.session;assert.equal(f.ui.editor.getText(),'');f.terminal.input('Second unsent draft');
 await f.app.changeSession(await Session.load(first.meta.id,f.app.home));assert.equal(f.ui.editor.getText(),'First unsent draft');await f.app.reload();assert.equal(f.ui.editor.getText(),'First unsent draft');
 await f.app.changeSession(await Session.load(second.meta.id,f.app.home));assert.equal(f.ui.editor.getText(),'Second unsent draft');assert.equal(f.requests.length,0);
});

test('model/account menu search is never saved over the real draft, including closing while filtering',async t=>{
 const f=await setup(t);f.terminal.input('Preserve the actual prompt');await f.app.flushDraft();
 const menu=f.ui.composerMenu('Model',[{value:'model',label:'Model'}]);f.terminal.input('DO NOT SAVE FILTER');await f.app.flushDraft();assert.equal((await snapshot(f.session)).text,'Preserve the actual prompt');await f.app.close();await menu;
 const restored=await Session.load(f.session.meta.id,f.app.home);assert.equal(await restored.getDraft(),'Preserve the actual prompt');assert.equal(f.requests.length,0);
});

test('submitting clears the saved draft only after accepting the message, and unsent text never enters model input',async t=>{
 const f=await setup(t);f.terminal.input('Submit this prompt');await f.app.flushDraft();f.terminal.input('\r');await until(()=>f.requests.length===1&&!f.app.engine.busy);await f.app.flushDraft();assert.equal((await snapshot(f.session)).text,'');assert.equal(f.session.messages.filter(m=>m.role==='user'&&!m.internal).length,1);
 f.terminal.input('PRIVATE UNSENT NEXT PROMPT');await f.app.flushDraft();assert.ok(!JSON.stringify(f.requests).includes('PRIVATE UNSENT NEXT PROMPT'));assert.equal(f.requests.length,1);
});

test('clearing a draft hides and discards an unnamed empty session, without reviving a legacy draft',async t=>{
 const f=await setup(t);await f.session.event({type:'state',state:{composerDraft:'Old legacy prompt'}});f.terminal.input('Temporary text');await f.app.flushDraft();assert.equal((await Session.list(f.app.home)).length,1);
 f.ui.editor.setText('');await f.app.flushDraft();assert.deepEqual(await Session.list(f.app.home),[]);const restored=await Session.load(f.session.meta.id,f.app.home);assert.equal(await restored.getDraft(),'');await f.app.close();assert.equal(await stat(f.session.dir).catch(()=>null),null);
});

test('rapid edits coalesce to the latest draft and save failures surface and recover',async()=>{
 const writes=[],errors=[];let release;const gate=new Promise(r=>release=r);const session={saveDraft:async text=>{writes.push(text);if(writes.length===1)await gate;}};
 const saver=new DraftAutosave({onError:error=>errors.push(error)});saver.schedule(session,'first');await delay(0);for(let i=0;i<100;i++)saver.schedule(session,'edit '+i);release();await saver.flush();assert.deepEqual(writes,['first','edit 99']);
 let fail=true;const broken={saveDraft:async()=>{if(fail)throw new Error('disk fixture full');}};saver.schedule(broken,'keep this');await assert.rejects(saver.flush(),/disk fixture full/);assert.equal(errors.length,1);fail=false;saver.schedule(broken,'keep this');await saver.flush();
});

test('a complete draft remains discoverable when the metadata snapshot is stale',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),before=await readFile(join(f.session.dir,'meta.json'),'utf8');await f.session.saveDraft('Crash-safe draft');await writeFile(join(f.session.dir,'meta.json'),before);assert.equal((await Session.list(f.app.home))[0].id,f.session.meta.id);assert.equal(await f.session.discardEmpty(),false);
});

test('drafts save during active inference without appearing in subsequent model requests',async t=>{
 let release,ready;const gate=new Promise(r=>release=r),arrived=new Promise(r=>ready=r);
 const f=await fixture(t,async(_p,n)=>{if(n===1){ready();await gate;return{call:{name:'write',args:{path:'done.txt',content:'done'}}};}return{text:'Complete.'};});f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false});await f.app.startUI();const run=f.app.submit('Execute the current task');await arrived;
 try{f.app.ui.terminal.input('PRIVATE UNSENT NEXT REQUEST');await f.app.flushDraft();assert.equal((await snapshot(f.session)).text,'PRIVATE UNSENT NEXT REQUEST');assert.equal(f.app.engine.busy,true);}finally{release();await run;}
 assert.equal(f.requests.length,2);assert.ok(!JSON.stringify(f.requests).includes('PRIVATE UNSENT NEXT REQUEST'));assert.equal(f.app.ui.editor.getText(),'PRIVATE UNSENT NEXT REQUEST');
});

test('a failed UI startup does not overwrite a previously saved prompt with the empty editor',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.saveDraft('Keep this through startup failure');f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false});f.app.agents.restore=async()=>{throw new Error('Startup fixture');};await assert.rejects(f.app.startUI(),/Startup fixture/);const saved=await Session.load(f.session.meta.id,f.app.home);assert.equal(await saved.getDraft(),'Keep this through startup failure');
});
