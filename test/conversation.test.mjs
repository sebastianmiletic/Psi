import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { stripTerminalSequences,visibleWidth } from '@earendil-works/pi-tui';
import { TerminalUI,commands } from '../src/ui.mjs';
import { ExplorationGroup } from '../src/message-ui.mjs';
import { Session } from '../src/session.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { fixture } from './helpers.mjs';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
async function setup(t){const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();return{...f,terminal,ui};}
const result=(text,isError=false)=>({isError,content:[{type:'text',text}]});

test('responses use an inline bullet, retain Markdown and streaming content, and have no repeated brand or phase headings',async t=>{
 const {ui}=await setup(t);ui.event({type:'request_start'});assert.equal(ui.response.render(80).length,0);assert.match(frame(ui).join('\n'),/Thinking/);
 ui.event({type:'text_delta',delta:'Implemented **LoopLab**.\n\n- Imports round-trip correctly.\n- Filters retain their state.\n\n```sh\nnpm start\n```'});
 const text=ui.response.text;for(const columns of[28,68,100]){const lines=ui.response.render(columns);assert.ok(lines.every(l=>visibleWidth(l)<=columns));const plain=lines.map(stripTerminalSequences).join('\n');assert.match(plain,/^• Implemented/);assert.match(plain,/npm start/);assert.doesNotMatch(plain,/Ψ|Psi|responding|thinking/);}
 const response=ui.response;ui.event({type:'request_end'});ui.event({type:'run_end',status:'idle'});assert.equal(response.text,text);assert.equal(response.active,false);assert.equal(ui.motionTimer,null);
});

test('consecutive read and search calls group in place; Ctrl+T reveals results without another model request',async t=>{
 const {ui,terminal,requests}=await setup(t);
 for(const [i,name,args]of[[1,'read',{path:'src/main.cpp'}],[2,'search',{pattern:'budget',path:'src'}],[3,'read',{path:'README.md'}]]){
  const call={id:String(i),name,arguments:args};ui.event({type:'tool_start',call});assert.match(frame(ui).join('\n'),/Exploring/);ui.event({type:'tool_end',call,duration:100,result:result('private routine file content '+i)});
 }
 assert.equal(ui.transcript.children.length,1);assert.ok(ui.transcript.children[0] instanceof ExplorationGroup);const compact=frame(ui).join('\n');assert.match(compact,/Explored/);assert.match(compact,/Read src\/main.cpp/);assert.match(compact,/Search budget in src/);assert.doesNotMatch(compact,/private routine/);
 terminal.input('\x14');assert.match(frame(ui).join('\n'),/private routine file content 1/);terminal.input('\x14');assert.doesNotMatch(frame(ui).join('\n'),/private routine/);assert.equal(requests.length,0);
 ui.markdown('The baseline is unchanged.');const call={id:'4',name:'read',arguments:{path:'next.cpp'}};ui.event({type:'tool_start',call});assert.equal(ui.transcript.children.length,3);ui.event({type:'tool_end',call,result:result('next')});
});

test('command output, failures, edits and background identities stay explicit and bounded',async t=>{
 const {ui,terminal}=await setup(t);
 const command={id:'shell',name:'bash',arguments:{command:'npm test'}};ui.event({type:'tool_start',call:command});assert.match(frame(ui).join('\n'),/Running npm test/);
 ui.event({type:'tool_end',call:command,duration:1234,result:result(JSON.stringify({id:'job-1',status:'failed',exitCode:1,output:Array.from({length:12},(_,i)=>'test line '+i).join('\n')}),true)});
 const compact=frame(ui).join('\n');assert.match(compact,/Ran npm test.*failed/);assert.match(compact,/job job-1.*failed.*exit 1/);assert.match(compact,/ctrl\+t/);assert.doesNotMatch(compact,/test line 11/);
 terminal.input('\x14');assert.match(frame(ui).join('\n'),/test line 11/);terminal.input('\x14');
 const edit={id:'edit',name:'edit',arguments:{path:'src/bot.cpp',old:'return 0;',new:'return 1;'}};ui.event({type:'tool_start',call:edit});ui.event({type:'tool_end',call:edit,result:result('Updated 1 match(es)')});assert.match(frame(ui).join('\n'),/Edited src\/bot.cpp/);assert.match(frame(ui).join('\n'),/- return 0;/);assert.match(frame(ui).join('\n'),/\+ return 1;/);
 const background={id:'bg',name:'bash',arguments:{command:'run sweep'}};ui.event({type:'tool_start',call:background});ui.event({type:'tool_end',call:background,result:result(JSON.stringify({id:'sweep-1',status:'running',output:'Started'}))});assert.match(frame(ui).join('\n'),/job sweep-1.*running/);
 for(const columns of[28,68,100]){terminal.resize(columns,32);frame(ui);assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=columns));}
});

test('stopped tools remain interrupted and subagents always sit below the usage bar through resize and menus',async t=>{
 const {ui,terminal}=await setup(t);const call={id:'interrupted',name:'bash',arguments:{command:'long check'}};ui.event({type:'tool_start',call});ui.event({type:'run_end',status:'stopped'});assert.match(frame(ui).join('\n'),/Ran long check.*stopped/);assert.match(frame(ui).join('\n'),/Interrupted before a result/);assert.equal(ui.openTools.size,0);
 ui.event({type:'agent_status',agent:{id:'worker',name:'Replay audit',model:'openai-codex/gpt-5.6-luna',status:'running',activity:'read'}});
 for(const [columns,rows]of[[100,32],[68,24],[28,18]]){terminal.resize(columns,rows);const lines=frame(ui);assert.ok(lines.findIndex(l=>l.includes('Replay audit'))>lines.findIndex(l=>l.includes('% left')));assert.ok(lines.some(l=>l.includes('Psi')));assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=columns));}
 terminal.resize(100,32);const menu=ui.effortMenu({levels:['off','low','medium','high'],effort:'medium',overkill:false});const lines=frame(ui);assert.match(lines.slice(0,6).join('\n'),/Psi/);assert.ok(lines.findIndex(l=>l.includes('Replay audit'))>lines.findIndex(l=>l.includes('% left')));terminal.input('\x1b');await menu;
});

test('/name persists the current session title through list and resume without replacing context or making inference calls',async t=>{
 const {app,session,requests,ui}=await setup(t);await session.message({role:'user',content:'Original task',timestamp:Date.now()});await session.event({type:'state',state:{loopGoal:'Unfinished work'}});app.engine.busy=true;
 await app.submit('/name Experiment 7');app.engine.busy=false;assert.equal(session.meta.title,'Experiment 7');assert.ok(commands.some(c=>c.name==='name'));
 const saved=(await Session.list(app.home)).find(s=>s.id===session.meta.id);assert.equal(saved.title,'Experiment 7');const resumed=await Session.load(session.meta.id,app.home);assert.equal(resumed.meta.title,'Experiment 7');assert.equal(resumed.messages[0].content,'Original task');assert.equal(resumed.state.loopGoal,'Unfinished work');assert.equal(requests.length,0);
 await resumed.rename('New session');await resumed.message({role:'user',content:'Keep the explicit name',timestamp:Date.now()});assert.equal(resumed.meta.title,'New session');assert.equal(JSON.parse(await readFile(join(resumed.dir,'meta.json'))).named,true);ui.clear();
});

test('/name prompts without an argument; cancellation and invalid names preserve the title',async t=>{
 const {app,ui,terminal,session}=await setup(t);const original=session.meta.title;
 let prompt=app.submit('/name');assert.ok(ui.pending);terminal.input('\x1b');await prompt;assert.equal(session.meta.title,original);
 prompt=app.submit('/name');terminal.input('Benchmark study');terminal.input('\r');await prompt;assert.match(session.meta.title,/Benchmark.*study/);await assert.rejects(session.rename('  '),/Enter/);await assert.rejects(session.rename('x'.repeat(121)),/120/);
});
