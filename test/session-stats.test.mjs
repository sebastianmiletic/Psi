import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Statistics} from '../src/stats.mjs';
import {Session} from '../src/session.mjs';
import {readPackedJSON} from '../src/packed-json.mjs';
import {fixture} from './helpers.mjs';
const start=Date.parse('2026-11-07T09:00:00Z'),at=(seconds)=>new Date(start+seconds*1000).toISOString();
const event=(seconds,type,data)=>({type,at:at(seconds),...data});
const usage=(seconds,id,tokens,extra={})=>event(seconds,'usage',{requestId:id,provider:'fixture',accountId:'a',usage:{input:tokens/2,output:tokens/4,cacheRead:tokens/4,cacheWrite:0,totalTokens:tokens},...extra});
async function save(session,rows){await writeFile(join(session.dir,'events.jsonl'),rows.map(e=>JSON.stringify(e)+'\n').join(''));}

test('current-session totals include nested workers once and exclude other chats',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.app.home,parent=await Session.create(f.root,home),child=await Session.create(f.root,home,{parentSession:parent.meta.id}),other=await Session.create(f.root,home);
 await save(parent,[event(0,'status',{status:'running'}),usage(60,'parent',1000),usage(120,'agent:w:child',400,{sourceAt:at(120)}),event(140,'message',{message:{role:'user',content:'PRIVATE MESSAGE'}}),event(150,'message',{message:{role:'user',internal:true,content:'Internal'}}),event(160,'message',{message:{role:'toolResult',content:[{type:'text',text:'PRIVATE TOOL'}]}}),event(180,'status',{status:'idle'})]);
 await save(child,[event(60,'status',{status:'running'}),usage(120,'child',400),event(240,'status',{status:'idle'})]);await save(other,[usage(300,'other',9000)]);
 const stats=new Statistics(home),all=await stats.read({now:start+600000,sessionId:parent.meta.id}),s=all[3];assert.equal(all.length,4);assert.equal(s.period,'session');assert.equal(s.tokens,1400);assert.equal(s.requests,2);assert.equal(s.tools,1);assert.equal(s.messages,1);assert.equal(s.workers,1);assert.equal(s.activeMs,240000);assert.equal(s.agentMs,360000);assert.equal(s.cacheRead,350);assert.equal(s.humanMs,null);assert.equal(all[2].tokens,10400);
 assert.doesNotMatch(JSON.stringify(await readPackedJSON(join(home,'stats-cache.json'),null)),/PRIVATE MESSAGE|PRIVATE TOOL/);
 assert.deepEqual((await stats.read({now:start+600000,sessionId:parent.meta.id}))[3],s);
});

test('human time merges activity windows, excludes workers, stops on blur/close and caps inactivity',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),parent=await Session.create(f.root,f.app.home),child=await Session.create(f.root,f.app.home,{parentSession:parent.meta.id});
 await save(parent,[event(0,'ui_activity',{kind:'focus'}),event(15,'ui_activity',{kind:'input'}),event(45,'ui_activity',{kind:'input'}),event(60,'ui_activity',{kind:'blur'}),event(300,'ui_activity',{kind:'focus'}),event(315,'ui_activity',{kind:'input'}),event(330,'ui_activity',{kind:'closed'}),usage(800,'parent',100)]);
 await save(child,[event(0,'ui_activity',{kind:'focus'}),event(1000,'ui_activity',{kind:'closed'})]);
 const s=(await new Statistics(f.app.home).read({now:start+3600000,sessionId:parent.meta.id}))[3];assert.equal(s.humanMs,90000);assert.equal(s.activeMs,0);
});

test('live work time updates without new receipts; idle human time stops increasing after one minute',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),session=await Session.create(f.root,f.app.home);await save(session,[event(0,'status',{status:'running'}),event(0,'ui_activity',{kind:'focus'})]);
 for(const name of ['run.lock','ui.lock'])await writeFile(join(session.dir,name),JSON.stringify({pid:process.pid}));
 const stats=new Statistics(f.app.home),first=(await stats.read({now:start+30000,sessionId:session.meta.id}))[3],later=(await stats.read({now:start+600000,sessionId:session.meta.id}))[3];
 assert.equal(first.activeMs,30000);assert.equal(first.humanMs,30000);assert.equal(later.activeMs,600000);assert.equal(later.humanMs,60000);
});

test('an empty current session still has a session view and old stats cache rebuilds safely',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await mkdir(f.app.home,{recursive:true});await writeFile(join(f.app.home,'stats-cache.json'),JSON.stringify({schema:1,sessions:{old:{usage:[]}}}));
 const data=await new Statistics(f.app.home).read({sessionId:f.session.meta.id});assert.equal(data[3].tokens,0);assert.equal(data[3].humanMs,null);assert.equal(data[3].activeMs,0);assert.equal(data[3].period,'session');
});

test('undated legacy worker copies remain in all-time session tokens without leaking into calendar totals',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),session=await Session.create(f.root,f.app.home);await save(session,[usage(10,'agent:old-worker:old-request',200)]);
 const data=await new Statistics(f.app.home).read({now:start+100000,sessionId:session.meta.id});assert.equal(data[3].tokens,200);assert.equal(data[3].unknownDatedRequests,1);assert.equal(data[0].tokens,0);assert.equal(data[2].tokens,200);
});
