import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {startupSession} from '../src/startup.mjs';
import {defaults,saveConfig} from '../src/storage.mjs';

test('a process killed after a live text flush recovers the visible response without putting partial text in model context',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),module=new URL('../src/session.mjs',import.meta.url).href;
 const code="import {Session} from "+JSON.stringify(module)+";const s=await Session.create("+JSON.stringify(f.root)+","+JSON.stringify(f.app.home)+");await s.message({role:'user',content:'Recover this task',timestamp:Date.now()});await s.event({type:'stream_start',requestId:'live'});await s.event({type:'stream_delta',requestId:'live',text:'Saved before abrupt termination'});console.log(s.meta.id);process.kill(process.pid,'SIGKILL');";
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:10000}),id=result.stdout.trim();assert.ok(id);const saved=await Session.load(id,f.app.home);
 assert.equal(saved.messages.length,1);assert.match(saved.visibleConversation().at(-1).content[0].text,/Saved before abrupt/);assert.equal(saved.visibleConversation().at(-1).partial,true);
 await saved.message({role:'assistant',content:[{type:'text',text:'Final complete response'}],timestamp:Date.now()},{requestId:'live'});assert.equal(saved.visibleConversation().length,2);assert.equal(saved.streaming,null);
});
test('bare startup resumes the last active conversation and its saved directory; --new remains empty',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),first=f.session;await first.message({role:'user',content:'Older chat',timestamp:Date.now()});await delay(5);
 const second=await Session.create(f.root,f.app.home);await second.message({role:'user',content:'Newer-created chat',timestamp:Date.now()});await delay(5);await first.message({role:'user',content:'Most recent activity',timestamp:Date.now()});
 assert.equal((await Session.list(f.app.home))[0].id,first.meta.id);
 const resumed=await startupSession({home:f.app.home,cwd:'/',interactive:true});assert.equal(resumed.meta.id,first.meta.id);assert.equal(resumed.meta.cwd,f.root);await resumed.uiLease?.release();
 const fresh=await startupSession({home:f.app.home,cwd:f.root,interactive:true,newSession:true});assert.equal(fresh.messages.length,0);assert.notEqual(fresh.meta.id,first.meta.id);await fresh.discardEmpty();
});
test('first-message journal commits are discoverable even if their title snapshot never finished',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.event({type:'message',message:{role:'user',content:'Crash-safe first message',timestamp:Date.now()}});const rows=await Session.list(f.app.home);assert.equal(rows[0].title,'Crash-safe first message');assert.equal((await Session.load(f.session.meta.id,f.app.home)).meta.title,'Crash-safe first message');
});
test('accepted input and queued follow-ups reach disk before they are displayed, and closing preserves them',async t=>{
 let ready,release;const arrived=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,async()=>{ready();await gate;return{text:'Done'};});t.after(()=>release());const seen=[];
 f.app.ui={user:text=>{seen.push(text);},stop(){},event(){},render(){}};
 const first=f.app.submit('First durable message');await arrived;await f.app.submit('Queued durable correction');
 const lines=(await readFile(join(f.session.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(lines.some(e=>e.message?.content==='First durable message'));assert.ok(lines.some(e=>e.state?.queuedMessages?.includes('Queued durable correction')));assert.deepEqual(seen,['First durable message','Queued durable correction']);
 await f.app.close();await first;const restored=await Session.load(f.session.meta.id,f.app.home);assert.deepEqual(restored.state.queuedMessages,['Queued durable correction']);assert.equal(restored.messages.filter(m=>m.role==='user'&&!m.internal).length,1);release();
});
test('reload accepts role-free workers and source changes restart only after persisting session and draft',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Keep my active chat',timestamp:Date.now()});
 await saveConfig({...f.config,agents:[{id:'legacy',name:'Old worker',mode:'execute',maxSteps:10}]},f.app.home);
 const {TerminalUI}=await import('../src/ui.mjs'),{MemoryTerminal}=await import('./terminal.mjs'),ui=new TerminalUI(f.app,{terminal:new MemoryTerminal(100,32)});f.app.ui=ui;ui.start();t.after(()=>ui.stop());
 assert.equal(await f.app.reload(),true);assert.equal(f.app.engine.config.agents,undefined);
 ui.editor.setText('Unsent draft');let restarted;f.app.options.buildIdentity=async()=> 'changed';f.app.options.onRestart=async data=>{restarted=data;};assert.equal(await f.app.reload(),true);assert.equal(restarted.sessionId,f.session.meta.id);
 const restored=await Session.load(f.session.meta.id,f.app.home);assert.equal(restored.state.composerDraft,'Unsent draft');assert.equal(restored.meta.hasMessages,true);
});
test('history restore includes the latest saved messages and interrupted text instead of only eight entries',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));for(let i=0;i<15;i++)await f.session.message({role:i%2?'assistant':'user',content:i%2?[{type:'text',text:'Message '+i}]:'Message '+i,timestamp:Date.now()});
 await f.session.event({type:'stream_start',requestId:'last'});await f.session.event({type:'stream_delta',requestId:'last',text:'Latest streamed text'});const displayed=[];let bottom=false;
 f.app.ui={user:text=>displayed.push(text),markdown:text=>displayed.push(text),scroll:{scrollToEnd(){bottom=true;}},stop(){}};f.app.showHistory();assert.equal(displayed.length,16);assert.match(displayed.at(-1),/Latest streamed text/);assert.match(displayed.at(-1),/Interrupted response/);assert.equal(bottom,true);
});
test('a torn trailing record cannot hide a committed first message from saved history',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.event({type:'message',message:{role:'user',content:'Keep committed input',timestamp:Date.now()}});await appendFile(join(f.session.dir,'events.jsonl'),'{"type":"stream_delta","text":"cut off');
 assert.equal((await Session.list(f.app.home))[0].title,'Keep committed input');const restored=await Session.load(f.session.meta.id,f.app.home);assert.equal(restored.messages[0].content,'Keep committed input');assert.ok((await readFile(join(f.session.dir,'events.jsonl'),'utf8')).endsWith('\n'));
});
test('live saving leaves request messages unchanged and does not duplicate assistant text on resume',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{text:'First full response'}:{text:'Second full response'});await f.app.engine.run('First question');await f.app.engine.run('Second question');
 const data=await readFile(join(f.session.dir,'events.jsonl'),'utf8');assert.match(data,/"type":"stream_delta"/);
 assert.equal(f.requests[1].messages.filter(m=>m.role==='assistant'&&m.content==='First full response').length,1);assert.ok(!JSON.stringify(f.requests[1].messages).includes('stream_delta'));
 const loaded=await Session.load(f.session.meta.id,f.app.home);assert.equal(loaded.visibleConversation().filter(m=>Array.isArray(m.content)&&m.content.some(c=>c.text==='First full response')).length,1);assert.equal(loaded.streaming,null);
});
