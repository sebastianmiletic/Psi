import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers.mjs';
import { TerminalUI,commands } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { importPi } from '../src/pi-import.mjs';
import { newer,checkUpdate } from '../src/updates.mjs';
const call=(f,name,args)=>f.app.tools.call({id:'test-'+name,name,arguments:args});

test('directory grants resolve symlinks, persist across resume, and can be revoked',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),outside=await mkdtemp(join(tmpdir(),'psi-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'private.txt'),'private');
 assert.equal((await call(f,'read',{path:join(outside,'private.txt')})).isError,true);
 if(process.platform!=='win32'){await symlink(outside,join(f.root,'escape'));assert.equal((await call(f,'write',{path:'escape/created.txt',content:'no'})).isError,true);}
 await f.app.tools.policy.change('add',outside);assert.equal((await call(f,'read',{path:join(outside,'private.txt')})).isError,false);
 await f.app.tools.policy.change('remove',outside);assert.equal((await call(f,'read',{path:join(outside,'private.txt')})).isError,true);
});
test('shell commands cannot read/write a sibling directory, even through Python or inherited environment secrets',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
 const f=await fixture(t,()=>({text:'unused'})),outside=await mkdtemp(join(tmpdir(),'psi-forbidden-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'secret.txt'),'secret');
 process.env.PSI_TEST_SECRET='must-not-leak';t.after(()=>delete process.env.PSI_TEST_SECRET);
 const command=`python3 -c 'import os,pathlib; print("env",os.getenv("PSI_TEST_SECRET")); pathlib.Path(${JSON.stringify(join(outside,'secret.txt'))}).read_text()'`;
 const result=await call(f,'bash',{command,yield_ms:2000});assert.equal(result.isError,true);assert.match(result.content[0].text,/PermissionError|Operation not permitted|FileNotFoundError/);assert.doesNotMatch(result.content[0].text,/must-not-leak/);
 const write=await call(f,'bash',{command:`printf forbidden > '${join(outside,'written.txt')}'`,yield_ms:2000});assert.equal(write.isError,true);await assert.rejects(readFile(join(outside,'written.txt')));
});
test('plan mode blocks mutations and shell commands while recording a durable plan',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.app.update({agentMode:'plan'});
 for(const [name,args]of [['write',{path:'forbidden',content:'bad'}],['bash',{command:'touch forbidden'}],['browser',{action:'evaluate',script:'1'}]])assert.equal((await call(f,name,args)).isError,true);
 const result=await call(f,'progress',{steps:[{title:'Inspect current code',status:'complete'},{title:'Implement after user feedback',status:'pending'}],update:'Plan ready.'});assert.equal(result.isError,false);assert.equal(f.session.state.progress.percent,50);await assert.rejects(readFile(join(f.root,'forbidden')));
});
test('double Escape stops, Shift+Tab changes mode, and removed slash commands are absent',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,28),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;ui.start();t.after(()=>ui.stop());
 let stopped=0;f.app.engine.busy=true;const original=f.app.engine.stop.bind(f.app.engine);f.app.engine.stop=()=>{stopped++;original();};terminal.input('\x1b');assert.equal(stopped,0);terminal.input('\x1b');assert.equal(stopped,1);f.app.engine.busy=false;
 terminal.input('\x1b[Z');await ui.modeSwitch;assert.equal(f.app.engine.config.agentMode,'plan');
 for(const name of ['continue','stop','jobs','budget','limit','tokens']){assert.ok(!commands.some(c=>c.name===name));await assert.rejects(f.app.submit('/'+name),/removed/);}
 assert.doesNotMatch(ui.tui.getScreenLines().join('\n'),/Build, research, benchmark|Tools run with full access/);
});
test('Tab in /effort toggles OVERKILL without changing the selected thinking level',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,28),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;ui.start();t.after(()=>ui.stop());
 const menu=f.app.submit('/effort');await delay(5);terminal.input('\t');await delay(30);assert.equal(ui.effortPreview.overkill,true);assert.equal(f.app.engine.config.overkill,false);terminal.input('\r');await menu;assert.equal(f.app.engine.config.overkill,true);assert.equal(f.app.engine.config.effort,'off');assert.ok(f.app.tools.entries.has('agent'));
});
test('independent subagent uses its configured model, writes within the inherited workspace and accounts usage exactly once',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{call:{name:'write',args:{path:'worker-result.txt',content:'verified child output'}}}:{text:'Worker completed the assigned file.'});
 await f.app.update({overkill:true,agents:[{id:'worker',name:'Worker',job:'Write the assigned file',model:'fixture/test',effort:'off',mode:'execute',maxSteps:10}]});
 const r=await f.app.agents.spawn({profile:'worker',prompt:'Write worker-result.txt and report evidence.'});const result=await f.app.agents.wait(r.id);assert.equal(result.status,'completed');assert.equal(await readFile(join(f.root,'worker-result.txt'),'utf8'),'verified child output');assert.equal(f.session.totals.requests,2);await f.app.agents.wait(r.id);assert.equal(f.session.totals.requests,2);assert.equal(f.requests.length,2);
});
test('Pi import is idempotent and shares refreshed credentials under the Pi file lock without changing selection',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),path=join(f.root,'pi-accounts.json'),credential={type:'oauth',access:'test-private-access',refresh:'test-private-refresh',expires:9999999999999,accountId:'test-account'};
 await writeFile(path,JSON.stringify({version:1,providers:{'openai-codex':{active:'One',accounts:{One:credential,Two:{...credential,accountId:'second'}}}}}));const before=await readFile(path,'utf8');
 const imported=await importPi(f.app.registry.accounts,path,['One','Two']);await importPi(f.app.registry.accounts,path,['One','Two']);assert.equal((await f.app.registry.accounts.list()).length,2);assert.equal(await readFile(path,'utf8'),before);
 const one=imported[0],store=f.app.registry.accounts.store({...one,type:'oauth'});await store.modify('openai-codex',c=>({...c,access:'new-private-access',refresh:'new-private-refresh'}));assert.equal((await store.read('openai-codex')).access,'new-private-access');const data=JSON.parse(await readFile(path));assert.equal(data.providers['openai-codex'].active,'One');assert.equal(data.providers['openai-codex'].accounts.Two.refresh,'test-private-refresh');
});
test('GitHub update check uses stable releases, caches results and compares semantic versions',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));assert.equal(newer('0.10.0','0.2.9'),true);assert.equal(newer('0.1.9','0.2.0'),false);let n=0;const fetchImpl=async()=>{n++;return new Response(JSON.stringify({tag_name:'v9.0.0',html_url:'https://github.com/sebastianmiletic/Psi/releases/tag/v9.0.0',assets:[]}));};const a=await checkUpdate(f.session.home,{fetchImpl});assert.equal(a.available,true);await checkUpdate(f.session.home,{fetchImpl});assert.equal(n,1);
});

test('queued steering is applied after the next tool and remaining old calls are skipped with recorded outcomes',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{calls:[{name:'write',args:{path:'first.txt',content:'first'}},{name:'write',args:{path:'must-not-run.txt',content:'stale'}}]}:{text:'Applied the queued correction.'});
 const original=f.app.options.onEvent;f.app.options.onEvent=e=>{original(e);if(e.type==='tool_end'&&e.call.arguments.path==='first.txt')f.app.engine.steer('Stop the old plan and apply this correction.');};
 await f.app.engine.run('Run both writes.');assert.equal(await readFile(join(f.root,'first.txt'),'utf8'),'first');await assert.rejects(readFile(join(f.root,'must-not-run.txt')));assert.equal(f.requests.length,2);assert.equal(f.session.messages.filter(m=>m.role==='toolResult').length,2);assert.match(f.requests[1].messages.at(-1).content,/queued|correction/);assert.deepEqual(f.session.state.queuedMessages,[]);
});
test('switching to plan during inference prevents the first returned mutation',async t=>{
 let release,arrived;const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,async(_p,n)=>{if(n===1){arrived();await gate;return{call:{name:'write',args:{path:'blocked.txt',content:'stale mutation'}}};}return{text:'Read-only plan prepared.'};});
 const running=f.app.engine.run('Implement the change.');await ready;await f.app.engine.settings({agentMode:'plan'});release();await running;await assert.rejects(readFile(join(f.root,'blocked.txt')));assert.equal(f.session.messages.find(m=>m.role==='toolResult').isError,true);
});
test('plan-mode parent forces read-only workers and completed workers can receive a new task',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{call:{name:'write',args:{path:'forbidden-child.txt',content:'no'}}}:{text:'Read-only worker response.'});
 await f.app.update({agentMode:'plan',overkill:true,agents:[{id:'worker',name:'Worker',job:'Inspect the task',model:'fixture/test',effort:'off',mode:'execute',maxSteps:10}]});
 const r=await f.app.agents.spawn({profile:'worker',prompt:'Inspect without changing files.'});await f.app.agents.wait(r.id);await assert.rejects(readFile(join(f.root,'forbidden-child.txt')));await f.app.agents.send(r.id,'Review the previous result again.');const result=await f.app.agents.wait(r.id);const diagnostic=await readFile(join(f.app.jobs.path(result.jobId),'worker.log'),'utf8').catch(()=> '');assert.equal(result.status,'completed',JSON.stringify(result)+'\n'+diagnostic);assert.equal(f.session.totals.requests,3);
});

test('isolated Python alias and zsh heredoc use private scratch instead of /tmp',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,()=>({text:'unused'}));const r=await call(f,'bash',{command:"python - <<'PY'\nprint('heredoc-ok')\nPY",yield_ms:2000});assert.equal(r.isError,false,r.content[0].text);assert.match(r.content[0].text,/heredoc-ok/);
});

test('administrative CLI commands construct workspace policy without creating a conversation session',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));const {spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 for(const args of [['accounts','list'],['doctor'],['providers','codex']]){
  const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../bin/psi.mjs',import.meta.url)),...args,'--json'],{env:{...process.env,PSI_HOME:f.session.home},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});
  if(args[0]==='doctor')assert.ok([0,1].includes(result.code),result.err);else assert.equal(result.code,0,result.err);assert.doesNotThrow(()=>JSON.parse(result.out));
 }
});

test('a previously executing worker resumes read-only when its parent switches to plan',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{text:'Initial worker finished.'}:n===2?{call:{name:'write',args:{path:'forbidden-resume.txt',content:'no'}}}:{text:'Read-only follow-up completed.'});
 await f.app.update({overkill:true,agents:[{id:'worker',name:'Worker',job:'Follow the assigned mode',model:'fixture/test',effort:'off',mode:'execute',maxSteps:10}]});
 const r=await f.app.agents.spawn({profile:'worker',prompt:'Inspect the task.'});await f.app.agents.wait(r.id);await f.app.setMode('plan');await f.app.agents.send(r.id,'Inspect again in plan mode.');await f.app.agents.wait(r.id);await assert.rejects(readFile(join(f.root,'forbidden-resume.txt')));assert.equal(f.session.totals.requests,3);
});

test('source updater refuses local changes before fetching or overwriting the checkout',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));const {run,updateInstallation}=await import('../src/updates.mjs');const root=join(f.root,'source');await mkdir(root);await run('git',['init'],root);await run('git',['remote','add','origin','https://github.com/sebastianmiletic/Psi.git'],root);await writeFile(join(root,'local.txt'),'preserve this');
 await assert.rejects(updateInstallation(f.session.home,{root,release:{available:true,latest:'9.0.0',assets:[]}}),/Local changes/);assert.equal(await readFile(join(root,'local.txt'),'utf8'),'preserve this');
});

test('job completion committed during the exit check is preserved instead of overwritten as interrupted',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),id='completion-race',path=join(f.app.jobs.path(id),'job.json');await mkdir(f.app.jobs.path(id),{recursive:true});await writeFile(path,JSON.stringify({id,pid:123456,status:'running',sessionId:f.session.meta.id}));
 const {writeFileSync}=await import('node:fs');f.app.jobs.isAlive=()=>{writeFileSync(path,JSON.stringify({id,pid:123456,status:'completed',sessionId:f.session.meta.id}));return false;};
 assert.equal((await f.app.jobs.get(id)).status,'completed');assert.equal(JSON.parse(await readFile(path)).status,'completed');
});

test('stopping a running subagent waits for its cancellation record on every OS',{timeout:15000},async t=>{
 let arrived,release;const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);t.after(()=>release());const f=await fixture(t,async()=>{arrived();await gate;return{text:'late response'};});
 await f.app.update({overkill:true,agents:[{id:'worker',name:'Worker',job:'Do the assigned task',model:'fixture/test',effort:'off',mode:'plan',maxSteps:10}]});
 const r=await f.app.agents.spawn({profile:'worker',prompt:'Inspect the task.'});await ready;
 try{await f.app.agents.stopAll({wait:true});const result=await f.app.agents.status(r.id);assert.equal(result.status,'cancelled');assert.equal(result.result.status,'stopped');}finally{release();}
});

test('atomic snapshots retry Windows sharing violations while preserving the previous committed file',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),path=join(f.root,'atomic.json');await writeFile(path,JSON.stringify({revision:1}));const {atomicJSON}=await import('../src/storage.mjs'),{rename}=await import('node:fs/promises');let attempts=0;
 await atomicJSON(path,{revision:2},{retrySharingViolations:true,renameImpl:async(from,to)=>{attempts++;assert.equal(JSON.parse(await readFile(path)).revision,1);if(attempts<4){const e=new Error('sharing violation');e.code='EPERM';throw e;}await rename(from,to);}});
 assert.equal(attempts,4);assert.equal(JSON.parse(await readFile(path)).revision,2);
});

test('a completion event during an in-flight job read triggers another read without the backup polling delay',{timeout:5000},async t=>{
 const f=await fixture(t,()=>({text:'unused'})),id='watch-race',path=join(f.app.jobs.path(id),'job.json');await mkdir(f.app.jobs.path(id),{recursive:true});await writeFile(path,JSON.stringify({id,status:'running'}));
 const get=f.app.jobs.get.bind(f.app.jobs);let first=true,entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.app.jobs.get=async id=>{const result=await get(id);if(first){first=false;entered();await gate;}return result;};
 const waiting=f.app.jobs.awaitCompletion(id);await ready;await writeFile(path,JSON.stringify({id,status:'completed'}));await delay(30);release();const result=await waiting;assert.equal(result.status,'completed');
});
