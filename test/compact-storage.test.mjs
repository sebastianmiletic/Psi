import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,appendFile,rename,mkdir,readdir,stat,utimes,readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fixture } from './helpers.mjs';
import { Session } from '../src/session.mjs';
import { journalLines,journalInfo,compactJournal,SEGMENT_BYTES,compressFile } from '../src/journal.mjs';
import { Statistics } from '../src/stats.mjs';
import { readPackedJSON,writePackedJSON,pruneWebCache } from '../src/packed-json.mjs';
import { sharedToolCache } from '../src/tool-cache.mjs';
import { compactStorage } from '../src/storage-maintenance.mjs';
const rows=async dir=>{const result=[];for await(const row of journalLines(dir))result.push(row);return result;};
const text='Ψ 🧠 Compression must keep every original byte.\n'.repeat(7000);

test('large live journals compress losslessly and reopen with identical inference and visible history',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));
 const user={role:'user',content:text,timestamp:1},answer={role:'assistant',content:[{type:'text',text:'All evidence preserved.'}],timestamp:2};
 await f.session.message(user);await f.session.message(answer);await f.session.event({type:'state',state:{composerDraft:'Unsent draft',queuedMessages:['Follow up']}});
 const before=JSON.stringify(f.session.messages),visible=JSON.stringify(f.session.transcriptView()),events=await rows(f.session.dir),logical=events.at(-1).offset;
 const gz=(await readdir(join(f.session.dir,'history'))).filter(n=>n.endsWith('.psi'));assert.equal(gz.length,1);
 assert.ok((await stat(join(f.session.dir,'history',gz[0]))).size<Buffer.byteLength(text)/10);
 const loaded=await Session.load(f.session.meta.id,f.session.home);assert.equal(JSON.stringify(loaded.messages),before);assert.equal(JSON.stringify(loaded.transcriptView()),visible);assert.equal(loaded.state.composerDraft,'Unsent draft');assert.deepEqual(loaded.state.queuedMessages,['Follow up']);
 assert.equal((await journalInfo(f.session.dir)).size,logical);assert.match(await f.app.exportMarkdown(),/All evidence preserved/);
 const result=await f.app.tools.call({id:'history',name:'read',arguments:{path:join(f.session.dir,'events.jsonl'),offset:2,limit:1}});assert.equal(result.isError,false);assert.match(result.content[0].text,/All evidence preserved/);assert.equal(f.requests.length,0);
});

test('legacy migration keeps complete records, repairs only a torn tail, and leaves the continuation writable',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),event={type:'message',at:new Date().toISOString(),message:{role:'user',content:text,timestamp:1}};
 const raw=JSON.stringify(event)+'\n';await writeFile(join(f.session.dir,'events.jsonl'),raw+'{"type":"message","cut');
 const loaded=await Session.load(f.session.meta.id,f.session.home);assert.deepEqual(loaded.messages,[event.message]);
 await loaded.message({role:'assistant',content:[{type:'text',text:'After migration'}],timestamp:2});
 assert.equal((await rows(f.session.dir))[0].line,raw.trimEnd());assert.equal((await Session.load(loaded.meta.id,loaded.home)).messages.length,2);
 const old=f.session;await old.compactStorage();await assert.rejects(old.assertLatest(),/changed in another/);f.app.session=loaded;f.app.bind();
});

test('recovery handles raw rotated segments and a verified compressed duplicate without replaying twice',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Committed input',timestamp:1});
 const path=join(f.session.dir,'events.jsonl'),raw=await readFile(path),history=join(f.session.dir,'history');await mkdir(history);
 const base=join(history,`000000000001-${raw.length}.jsonl`);await rename(path,base);await compressFile(base,{remove:false});
 assert.equal((await rows(f.session.dir)).length,1);await writeFile(base.replace(/\.jsonl$/,'.psi')+'.00000000-0000-0000-0000-000000000000.tmp','abandoned stage');
 assert.equal((await rows(f.session.dir)).length,1);await compactJournal(f.session.dir,{repair:true});assert.deepEqual(await readdir(history),[base.split(/[/\\]/).at(-1).replace(/\.jsonl$/,'.psi')]);
 const loaded=await Session.load(f.session.meta.id,f.session.home);await loaded.message({role:'user',content:'Continuation',timestamp:2});assert.deepEqual(loaded.messages.map(m=>m.content),['Committed input','Continuation']);f.app.session=loaded;f.app.bind();
});

test('compressed corruption fails explicitly instead of silently dropping saved history',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:text,timestamp:1});
 const root=join(f.session.dir,'history'),name=(await readdir(root))[0],path=join(root,name),saved=await readFile(path);
 const broken=Buffer.from(saved);broken[broken.length-5]^=255;await writeFile(path,broken);
 await assert.rejects(async()=>rows(f.session.dir),/check|invalid|corrupt|unexpected|decompression failed/i);
 await writeFile(path,saved);assert.equal((await rows(f.session.dir)).length,1);
});

test('statistics remain exact across compression, further appends and repeated cache reads',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),stats=new Statistics(f.session.home),usage=id=>({type:'usage',requestId:id,provider:'fixture',usage:{input:70,cacheRead:30,output:20,totalTokens:120}});
 await f.session.event(usage('one'));assert.equal((await stats.read())[2].tokens,120);
 await f.session.message({role:'user',content:text,timestamp:1});await f.session.event(usage('two'));assert.equal((await stats.read())[2].tokens,240);
 await f.session.compactStorage();assert.equal((await stats.read())[2].tokens,240);await f.session.event(usage('three'));assert.equal((await stats.read())[2].tokens,360);assert.equal((await stats.read())[2].tokens,360);
 const cache=join(f.session.home,'stats-cache.json');assert.equal(await stat(cache).catch(()=>null),null);assert.ok(await readPackedJSON(cache,null));assert.doesNotMatch(gunzipSync(await readFile(cache+'.gz')).toString(),/Compression must keep/);
});

test('a snapshot reader survives concurrent appends and sealing without losing or duplicating committed rows',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Snapshot',timestamp:1});
 let release;const gate=new Promise(r=>{release=r;});let started;const ready=new Promise(r=>{started=r;});
 const reader=(async()=>{const seen=[];for await(const row of journalLines(f.session.dir)){seen.push(row);started();await gate;}return seen;})();await ready;
 const writer=f.session.message({role:'user',content:text,timestamp:2});release();assert.equal((await reader).length,1);await writer;assert.equal((await rows(f.session.dir)).length,2);await f.session.assertLatest();
});

test('packed cache migration and pruning remove disposable data while retaining session artifacts',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home,root=join(home,'web-cache');await mkdir(root);
 const legacy=join(root,'a'.repeat(24)+'.json'),page={text:'Website data '.repeat(1000),at:Date.now()};await writeFile(legacy,JSON.stringify(page));assert.deepEqual(await readPackedJSON(legacy,null),page);await writePackedJSON(legacy,page);assert.equal(await stat(legacy).catch(()=>null),null);assert.deepEqual(await readPackedJSON(legacy,null),page);assert.ok((await stat(legacy+'.gz')).size<200);
 const artifact=await f.app.tools.artifact('Saved evidence','web');await utimes(legacy+'.gz',new Date(0),new Date(0));await pruneWebCache(home);assert.equal(await stat(legacy+'.gz').catch(()=>null),null);assert.equal(await readFile(artifact,'utf8'),'Saved evidence');
 for(let i=0;i<3;i++){const path=join(root,String(i).repeat(24)+'.json.gz');await writeFile(path,Buffer.alloc(100));await utimes(path,new Date(Date.now()+i),new Date(Date.now()+i));}
 assert.ok(await pruneWebCache(home,{maxBytes:150})<=150);assert.equal((await readdir(root)).length,1);
});

test('new sessions share tool downloads; idle maintenance preserves cache paths and skips open chats',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home;
 const a=join(f.root,'scratch-a'),b=join(f.root,'scratch-b');await mkdir(a);await mkdir(b);
 const ca=await sharedToolCache(home,a),cb=await sharedToolCache(home,b);await writeFile(join(ca.local,'download'),'SDK');assert.equal(await readFile(join(cb.local,'download'),'utf8'),'SDK');
 const legacy=await Session.create(f.root,home),cache=join(legacy.dir,'scratch',process.platform==='darwin'?'Library/Caches':'.cache');await mkdir(join(cache,'compiler'),{recursive:true});await writeFile(join(cache,'compiler','sdk'),'Old SDK');await writeFile(join(legacy.dir,'events.jsonl'),JSON.stringify({type:'message',message:{role:'user',content:text,timestamp:1},at:new Date().toISOString()})+'\n');
 await f.session.message({role:'user',content:'Keep open',timestamp:1});await writeFile(join(f.session.dir,'ui.lock'),JSON.stringify({pid:process.pid}));
 const report=await compactStorage(home);assert.ok(report.skipped.includes(f.session.meta.id));assert.ok(report.sessions>=1);assert.ok(report.afterBytes<report.beforeBytes);assert.equal(await readFile(join(cache,'compiler','sdk'),'utf8'),'Old SDK');assert.ok(await readlink(join(cache,'compiler')));assert.equal((await Session.load(legacy.meta.id,home)).messages[0].content,text);
});

test('diagnostics stay verbose but compress on close without altering inference events',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));for(let i=0;i<600;i++)await f.session.debug({type:'tool_end',tool:'read',duration:12,details:'diagnostic '.repeat(20)});
 await f.session.compactStorage();const dir=join(f.session.dir,'diagnostics'),history=join(dir,'history');assert.ok((await readdir(history)).some(n=>n.endsWith('.psi')));assert.equal((await rows(dir)).length,600);assert.equal((await rows(f.session.dir)).length,0);
});

test('compressed subagents keep one parent session and their usage is collected exactly once',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Parent task',timestamp:1});
 const child=await Session.create(f.root,f.session.home,{parentSession:f.session.meta.id});await child.message({role:'user',content:text,timestamp:1});
 await child.event({type:'usage',requestId:'child-request',provider:'fixture',usage:{input:70,cacheRead:30,output:20,totalTokens:120}});await child.compactStorage();
 const record={id:'worker',sessionId:child.meta.id};await f.app.agents.collect(record);await f.app.agents.collect(record);assert.equal(f.session.totals.requests,1);assert.equal(f.session.totals.input,70);assert.equal((await Session.list(f.session.home)).length,1);assert.equal(f.requests.length,0);
});

test('maintenance skips detached active jobs as well as writer locks',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home,locked=await Session.create(f.root,home),running=await Session.create(f.root,home);
 await writeFile(join(locked.dir,'run.lock'),JSON.stringify({pid:process.pid}));
 const job=join(home,'jobs','active-job');await mkdir(job,{recursive:true});await writeFile(join(job,'job.json'),JSON.stringify({id:'active-job',sessionId:running.meta.id,pid:process.pid,status:'running'}));
 const report=await compactStorage(home);assert.ok(report.skipped.includes(locked.meta.id));assert.ok(report.skipped.includes(running.meta.id));assert.equal(await stat(join(locked.dir,'history')).catch(()=>null),null);
 // A fixture must not try to terminate the current process through this synthetic job.
 await writeFile(join(job,'job.json'),JSON.stringify({id:'active-job',sessionId:running.meta.id,status:'completed'}));
});
