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
 terminal.input('\x1b[Z');await delay(40);assert.equal(f.app.engine.config.agentMode,'plan');
 for(const name of ['continue','stop','jobs','budget','limit','tokens']){assert.ok(!commands.some(c=>c.name===name));await assert.rejects(f.app.submit('/'+name),/removed/);}
 assert.doesNotMatch(ui.tui.getScreenLines().join('\n'),/Build, research, benchmark|Tools run with full access/);
});
test('Tab in /effort toggles OVERKILL without changing the selected thinking level',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,28),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;ui.start();t.after(()=>ui.stop());
 const menu=f.app.submit('/effort');await delay(5);terminal.input('\t');await delay(30);assert.equal(f.app.engine.config.overkill,true);terminal.input('\r');await menu;assert.equal(f.app.engine.config.effort,'off');assert.ok(f.app.tools.entries.has('agent'));
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
 const r=await f.app.agents.spawn({profile:'worker',prompt:'Inspect without changing files.'});await f.app.agents.wait(r.id);await assert.rejects(readFile(join(f.root,'forbidden-child.txt')));await f.app.agents.send(r.id,'Review the previous result again.');const result=await f.app.agents.wait(r.id);assert.equal(result.status,'completed');assert.equal(f.session.totals.requests,3);
});

test('isolated Python alias and zsh heredoc use private scratch instead of /tmp',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,()=>({text:'unused'}));const r=await call(f,'bash',{command:"python - <<'PY'\nprint('heredoc-ok')\nPY",yield_ms:2000});assert.equal(r.isError,false,r.content[0].text);assert.match(r.content[0].text,/heredoc-ok/);
});
