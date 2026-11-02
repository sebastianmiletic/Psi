import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fixture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {migrateWorkers} from '../src/worker-storage.mjs';
import {Directories} from '../src/directories.mjs';
import {Statistics} from '../src/stats.mjs';
import {withLock} from '../src/storage.mjs';
import {VerificationReceipts,evidenceReceipt} from '../src/evidence.mjs';
import {systemPrompt} from '../src/prompt.mjs';

const usage={input:100,output:20,cacheRead:300,cacheWrite:0,totalTokens:420,cost:{total:0.01}};
async function temp(t){const path=await mkdtemp(join(tmpdir(),'psi-efficiency-'));t.after(()=>rm(path,{recursive:true,force:true,maxRetries:5,retryDelay:20}));return path;}

test('naming and mode changes append context while the serialized instruction/tool prefix stays stable across resume',async t=>{
 let f;f=await fixture(t,async(_p,n)=>{
  if(n===1){await f.app.engine.settings({agentMode:'plan'});return{calls:[{name:'session_title',args:{title:'Parser inspection'}},{name:'read',args:{path:'input.txt'}},{name:'progress',args:{steps:[{title:'Inspect parser',status:'complete'}],update:'The input is available; I will explain the result.'}}]};}
  return{text:'Input inspected. No project files were changed.'};
 });await writeFile(join(f.root,'input.txt'),'fixture');await f.app.engine.run('Inspect this input');assert.equal(f.requests.length,2);assert.equal(f.requests[0].messages[0].content,f.requests[1].messages[0].content);assert.deepEqual(f.requests[0].tools,f.requests[1].tools);
 assert.ok(f.requests[1].messages.some(m=>typeof m.content==='string'&&m.content.includes('"mode":"plan"')));assert.equal(f.session.conversation.some(m=>m.internal||typeof m.content==='string'&&m.content.startsWith('Psi runtime state')),false);
 const metrics=[];for await(const e of f.session.events())if(e.type==='request_metrics')metrics.push(e);assert.equal(metrics.length,2);assert.equal(metrics[0].prefixHash,metrics[1].prefixHash);assert.equal(metrics[1].prefixChanged,false);assert.ok(metrics[0].systemCharacters>0);assert.equal(JSON.stringify(metrics).includes('Inspect this input'),false);
 const saved=await Session.load(f.session.meta.id,f.app.home);await f.app.changeSession(saved);await f.app.engine.run('Explain the same input');assert.equal(f.requests[2].messages[0].content,f.requests[0].messages[0].content);const last=f.events.filter(e=>e.type==='request_metrics').at(-1);assert.equal(last.prefixChanged,false);
 const entry=f.app.tools.entries.get('read');f.app.tools.entries.delete('read');f.app.tools.entries.set('read',entry);assert.deepEqual(f.app.tools.definitions().map(t=>t.name),f.requests[2].tools.map(t=>t.function.name));
});

test('independent file reads overlap within one response without another model request and progress receipts stay small',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{calls:[{name:'read',args:{path:'one'}},{name:'read',args:{path:'two'}}]}:{text:'Both files checked.'});let active=0,max=0;
 const read=f.app.tools.entries.get('read').execute;f.app.tools.entries.get('read').execute=async(...args)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));try{return await read(...args);}finally{active--;}};
 await writeFile(join(f.root,'one'),'1');await writeFile(join(f.root,'two'),'2');await f.app.engine.run('Read both files');assert.equal(max,2);assert.equal(f.requests.length,2);assert.equal(f.session.messages.filter(m=>m.role==='toolResult').length,2);
 const receipt=await f.app.tools.call({id:'plan',name:'progress',arguments:{steps:[{title:'A'.repeat(1000),status:'active'}],update:'B'.repeat(1000)}});assert.ok(receipt.content[0].text.length<300);assert.doesNotMatch(receipt.content[0].text,/AAA|BBB/);assert.equal(f.session.state.progress.steps[0].title.length,1000);
});

test('workers remain inside one parent session and nested statistics count usage exactly once',async t=>{
 const f=await fixture(t,()=>({text:'Assigned task complete.'}));await f.session.message({role:'user',content:'Parent assignment',timestamp:Date.now()});await f.app.update({overkill:true,agents:[],subagentConcurrency:2});
 const a=await f.app.agents.spawn({name:'Inspect parser input',prompt:'Inspect parser input.',checks:['npm test']}),b=await f.app.agents.spawn({name:'Inspect output contract',prompt:'Inspect output contract.'});await Promise.all([f.app.agents.wait(a.id),f.app.agents.wait(b.id)]);
 assert.deepEqual((await Session.list(f.app.home)).map(s=>s.id),[f.session.meta.id]);assert.equal((await Session.storageEntries(f.app.home)).length,3);assert.equal(await stat(join(f.app.home,'sessions',a.sessionId)).catch(()=>null),null);assert.ok(await stat(join(f.session.dir,'agents',a.sessionId,'worker-result.json')));
 const status=await f.app.agents.status(a.id);assert.deepEqual(status.result.verification.unverified,['npm test']);const stats=(await new Statistics(f.app.home).read()).find(s=>s.period==='all');assert.equal(stats.tokens,240);assert.equal(stats.requests,2);assert.equal(stats.workers,2);assert.equal(f.session.totals.requests,2);
 await f.app.agents.send(a.id,'Inspect the updated parser.');await f.app.agents.wait(a.id);assert.equal(f.session.totals.requests,3);assert.equal((await Session.list(f.app.home)).length,1);
});

test('legacy worker migration preserves journals, artifacts, results and usage while hiding workers from chat history',async t=>{
 const home=await temp(t),parent=await Session.create(home,home),child=await Session.create(home,home);await parent.message({role:'user',content:'Parent task',timestamp:Date.now()});await child.rename('Inspect legacy evidence');await child.message({role:'user',content:'Legacy task',timestamp:Date.now()});await child.event({type:'usage',requestId:'one',provider:'fixture',accountId:'account',usage});
 await mkdir(join(child.dir,'artifacts'));const oldArtifact=join(child.dir,'artifacts','proof.txt');await writeFile(oldArtifact,'proof');await writeFile(join(child.dir,'artifacts','run.lock'),'artifact, not process lock');await writeFile(join(child.dir,'worker.json'),JSON.stringify({parentSession:parent.meta.id,sessionId:child.meta.id,home,config:{},prompt:'Legacy task'}));await writeFile(join(child.dir,'worker-result.json'),JSON.stringify({summary:'Preserved evidence.'}));
 const journal=await readFile(join(child.dir,'events.jsonl'));assert.equal((await Session.list(home)).length,1);const result=await migrateWorkers(home);assert.equal(result.migrated.length,1);assert.equal(await stat(child.dir).catch(()=>null),null);
 const restored=await Session.load(child.meta.id,home,{parentSession:parent.meta.id});assert.deepEqual(await readFile(join(restored.dir,'events.jsonl')),journal);assert.equal(JSON.parse(await readFile(join(restored.dir,'worker-result.json'))).summary,'Preserved evidence.');assert.equal(restored.totals.requests,1);assert.equal(await readFile(join(restored.dir,'artifacts','run.lock'),'utf8'),'artifact, not process lock');
 const policy=new Directories(parent);assert.equal(await readFile(await policy.check(oldArtifact),'utf8'),'proof');assert.equal((await new Statistics(home).read()).find(s=>s.period==='all').tokens,420);assert.equal((await migrateWorkers(home)).migrated.length,0);
});

test('migration skips an actively locked worker without moving its data',async t=>{
 const home=await temp(t),parent=await Session.create(home,home),child=await Session.create(home,home);await writeFile(join(child.dir,'worker.json'),JSON.stringify({parentSession:parent.meta.id}));
 await withLock(join(child.dir,'run.lock'),async()=>{const r=await migrateWorkers(home);assert.deepEqual(r.skipped,[child.meta.id]);assert.ok(await stat(child.dir));});assert.equal((await migrateWorkers(home)).migrated.length,1);
});

test('delegation rejects duplicate tasks, overlapping reserved files and missing rationale before starting more workers',async t=>{
 let release,releaseNext,arrived,calls=0;const gate=new Promise(r=>release=r),nextGate=new Promise(r=>releaseNext=r),ready=new Promise(r=>arrived=r);t.after(()=>{release();releaseNext();});const f=await fixture(t,async()=>{arrived();await(++calls===1?gate:nextGate);return{text:'Done.'};});await f.app.update({overkill:true,agents:[],subagentConcurrency:3});
 const a=await f.app.agents.spawn({name:'Fix parser boundary',prompt:'Fix parser boundary',mode:'execute',files:['src/parser.js']});await ready;
 await assert.rejects(f.app.agents.spawn({name:'Duplicate parser work',prompt:' fix  parser boundary '}),/already has an active worker/);await assert.rejects(f.app.agents.spawn({name:'Rewrite parser module',prompt:'Rewrite the parser.',mode:'execute',files:['src']}),/overlapping/);
 const missing=await f.app.tools.call({id:'spawn',name:'agent',arguments:{action:'spawn',name:'Check another input',prompt:'Inspect another input.'}});assert.equal(missing.isError,true);assert.match(missing.content[0].text,/why|Explain/);
 const list=await f.app.tools.call({id:'list',name:'agent',arguments:{action:'list'}});const payload=JSON.parse(list.content[0].text);assert.equal(payload.runs.length,1);assert.equal(payload.runs[0].prompt,undefined);assert.equal(payload.runs[0].summary,undefined);assert.equal(f.requests.length,1);release();await f.app.agents.wait(a.id);
 const b=await f.app.agents.spawn({name:'Build parser replacement',prompt:'Build replacement.',mode:'execute',files:['src/parser.js']});await assert.rejects(f.app.agents.send(a.id,'Check the parser again'),/overlapping/);releaseNext();await f.app.agents.wait(b.id);
});

test('verification receipts require a completed zero-exit command and evidence receipts reject directories',async t=>{
 const v=new VerificationReceipts(),call={id:'one',name:'bash',arguments:{command:'npm test'}};v.event({type:'tool_start',call});v.event({type:'tool_end',call,result:{isError:false,content:[{type:'text',text:JSON.stringify({id:'job',status:'running'})}]}});assert.deepEqual(v.report(['npm test']).unverified,['npm test']);
 v.event({type:'tool_end',call:{name:'job',arguments:{id:'job'}},result:{isError:false,content:[{type:'text',text:JSON.stringify({id:'job',status:'completed',exitCode:0})}]}});assert.deepEqual(v.report(['npm test']).unverified,[]);
 const dir=await temp(t);await assert.rejects(evidenceReceipt(dir),/regular file/);const path=join(dir,'evidence.txt');await writeFile(path,'verified');const receipt=await evidenceReceipt(path);assert.equal(receipt.sha256,createHash('sha256').update('verified').digest('hex'));assert.equal(receipt.bytes,8);
});


test('repeated reads reuse an available full result, while file edits and compaction force fresh content',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));const path=join(f.root,'source.txt'),content='source evidence '.repeat(200);await writeFile(path,content);
 const read=async id=>{const result=await f.app.tools.call({id,name:'read',arguments:{path:'source.txt'}});await f.session.message(result);return result.content[0].text;};
 assert.match(await read('full'),/source evidence/);const compact=await read('repeat');assert.match(compact,/unchanged from read full/);assert.ok(compact.length<150);assert.match(await read('again'),/unchanged from read full/);
 await writeFile(path,'Changed evidence');assert.match(await read('changed'),/Changed evidence/);await f.session.event({type:'compact',messages:[]});assert.match(await read('after-compaction'),/Changed evidence/);assert.equal(f.requests.length,0);
});

test('job wait without an explicit interval awaits completion locally rather than returning for model polling',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let awaited=0,bounded=0;const job={id:'fixture-job',sessionId:f.session.meta.id,status:'running'};f.app.jobs.get=async()=>job;f.app.jobs.awaitCompletion=async()=>{awaited++;return{...job,status:'completed',exitCode:0};};f.app.jobs.wait=async()=>{bounded++;return job;};f.app.jobs.tail=async()=>'';
 const run=args=>f.app.tools.call({id:'wait-'+awaited,name:'job',arguments:args});await run({action:'wait',id:job.id});assert.equal(awaited,1);assert.equal(bounded,0);await run({action:'wait',id:job.id,wait_ms:100});assert.equal(bounded,1);assert.equal(f.requests.length,0);
});
