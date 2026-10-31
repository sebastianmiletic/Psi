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

test('finished subagents hide immediately while active overflow and saved worker details remain',async t=>{
 const {ui}=await setup(t);
 for(let i=0;i<4;i++)ui.event({type:'agent_status',agent:{id:'worker-'+i,name:'Audit '+i,model:'fixture/test',status:'running'}});
 assert.match(frame(ui).join('\n'),/Audit 2.*\+1/);
 ui.event({type:'agent_finished',agent:{id:'worker-0',name:'Audit 0',model:'fixture/test',status:'completed'}});
 let screen=frame(ui).join('\n');assert.doesNotMatch(screen,/Audit 0/);assert.match(screen,/Audit 3/);assert.equal(ui.workerRows.get('worker-0').status,'completed');
 for(const [i,status]of[[1,'failed'],[2,'cancelled'],[3,'completed']])ui.event({type:'agent_finished',agent:{id:'worker-'+i,name:'Audit '+i,model:'fixture/test',status}});
 assert.equal(ui.subagentBar.render(100).length,0);assert.doesNotMatch(frame(ui).join('\n'),/Audit [0-3]/);assert.equal(ui.workerRows.size,4);
 ui.event({type:'agent_started',agent:{id:'worker-0',name:'Follow-up audit',model:'fixture/test',status:'running'}});assert.match(frame(ui).join('\n'),/Follow-up audit/);
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

test('closing waits for a mode change to settle and does not restart quota monitoring afterward',async t=>{
 const {app,ui}=await setup(t);let release;const gate=new Promise(r=>release=r);t.after(()=>release());const update=app.update.bind(app);app.update=async patch=>{await gate;return update(patch);};
 ui.toggleMode();let closed=false;const closing=app.close().then(()=>closed=true);await new Promise(r=>setTimeout(r,10));assert.equal(closed,false);assert.equal(ui.closed,true);release();await closing;assert.equal(closed,true);assert.equal(ui.modeSwitch,null);assert.equal(ui.motionTimer,null);assert.ok(!app.quotaTimer);assert.equal(app.engine.config.agentMode,'plan');
});


test('saved workspace and chat title stay above the composer across resume, directory switching and narrow menus',async t=>{
 const {app,ui,terminal,root}=await setup(t);const {mkdir,writeFile,realpath}=await import('node:fs/promises');
 const folder=join(root,'Other project');await mkdir(folder);await writeFile(join(folder,'marker.txt'),'other workspace');await app.session.message({role:'user',content:'Inspect replay experiments',timestamp:Date.now()});await app.session.rename('Replay experiments');ui.markdown('Keep this conversation visible.');
 await app.submit('/directory "'+folder+'"');const canonical=await realpath(folder);assert.equal(app.session.meta.cwd,canonical);assert.equal(app.tools.cwd,canonical);assert.deepEqual(await app.tools.policy.roots(),[canonical]);assert.match(frame(ui).join('\n'),/Keep this conversation visible/);
 const read=await app.tools.call({id:'workspace',name:'read',arguments:{path:'marker.txt'}});assert.equal(read.isError,false);assert.match(read.content[0].text,/other workspace/);
 const saved=await Session.load(app.session.meta.id,app.home);assert.equal(saved.meta.cwd,canonical);await app.changeSession(await Session.create(root,app.home));await app.changeSession(saved);assert.equal(app.tools.cwd,canonical);assert.equal(app.session.meta.title,'Replay experiments');
 for(const [columns,rows]of[[100,32],[40,18],[28,12]]){terminal.resize(columns,rows);const header=ui.header.render(columns).map(stripTerminalSequences);const title=header.findIndex(l=>l.includes('Replay experiments')),path=header.findIndex(l=>l.includes('Other project'));assert.ok(title>=0);assert.ok(path>title);assert.ok(header.every(l=>visibleWidth(l)<=columns));}
 terminal.resize(100,32);const menu=ui.effortMenu({levels:['off','medium','high'],effort:'medium',overkill:false});assert.match(frame(ui).slice(0,6).join('\n'),/Replay experiments/);terminal.input('\x1b');await menu;
});

test('the AI can name a chat once in its normal turn and user names always override it through resume',async t=>{
 const {app,session}=await setup(t);await app.update({agentMode:'plan'});await session.message({role:'user',content:'Build a compact replay explorer with filters',timestamp:Date.now()});assert.equal(session.meta.title,'Build a compact replay explorer with filters');
 let result=await app.tools.call({id:'title',name:'session_title',arguments:{title:'Replay explorer'}});assert.equal(result.isError,false);assert.equal(session.meta.title,'Replay explorer');assert.equal(await session.autoName('A different title'),false);
 await app.submit('/name Tournament analysis');assert.equal(await session.autoName('Wrong title'),false);const saved=await Session.load(session.meta.id,app.home);assert.equal(saved.meta.title,'Tournament analysis');assert.equal(saved.meta.named,true);
 await Promise.all([saved.autoName('Concurrent automatic title'),saved.rename('Manual choice')]);assert.equal(saved.meta.title,'Manual choice');assert.equal((await Session.list(app.home)).find(s=>s.id===saved.meta.id).title,'Manual choice');
});

test('account menus search in the composer without chat messages or inference and refresh every account independently',async t=>{
 const {app,ui,terminal,requests,session}=await setup(t),now=Date.now();
 const accounts=[{id:'one',provider:'openai-codex',name:'Personal',type:'oauth'},{id:'two',provider:'openai-codex',name:'School',type:'oauth'},{id:'api',provider:'anthropic',name:'API',type:'api_key'}];
 app.registry.accounts.list=async()=>accounts;
 for(const a of accounts)await app.accountUsage.patch(a.id,{limits:a.type==='oauth'?[{kind:'quota',label:'5h',usedPercent:40,resetAt:now/1000+5400},{kind:'quota',label:'7d',usedPercent:20,resetAt:now/1000+172800}]:[],...(a.type==='oauth'?{resetCredits:{availableCount:a.id==='one'?2:0}}:{})});
 let updates=0;app.resets.read=async(a,{signal})=>{assert.equal(signal.aborted,false);updates++;return{usage:await app.accountUsage.get(a.id)};};
 ui.editor.setText('Do not send this draft');const original=session.messages.length,transcript=ui.transcript.children.length;
 for(const action of[undefined,'switch']){const menu=app.accountMenu(action);for(let i=0;i<50&&!ui.composerSearch;i++)await new Promise(r=>setTimeout(r,5));assert.ok(ui.composerSearch);terminal.input('School');let lines=frame(ui);assert.match(lines.join('\n'),/codex · School/);assert.doesNotMatch(lines.join('\n'),/codex · Personal|filter/);assert.equal(ui.editor.getText(),'School');assert.match(lines.join('\n'),/5h 1h 30m.*week 2d 0h.*resets 0/);await new Promise(r=>setTimeout(r,15));assert.equal(ui.editor.getText(),'School');terminal.resize(28,24);assert.match(frame(ui).join('\n'),/resets 0/);assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=28));terminal.resize(100,32);terminal.input('\x1b');await menu;assert.equal(ui.editor.getText(),'Do not send this draft');}
 assert.equal(updates,4);assert.equal(session.messages.length,original);assert.equal(ui.transcript.children.length,transcript);assert.equal(requests.length,0);
 let released;const gate=new Promise(r=>released=r);const menu=ui.composerMenu('Accounts',[{value:'old',label:'old'}],'',{refresh:async({signal,update})=>{await gate;assert.equal(signal.aborted,true);update([{value:'late',label:'Late update'}]);}});terminal.input('\x1b');await menu;released();await new Promise(r=>setTimeout(r,5));assert.equal(ui.pending,null);assert.doesNotMatch(frame(ui).join('\n'),/Late update/);
});


test('normal inference can assign its first chat title through the same persisted tool loop',async t=>{
 const {app,session,requests}=await fixture(t,(_,n)=>n===1?{call:{name:'session_title',args:{title:'Replay explorer'}}}:{text:'Ready to build the replay explorer.'});
 await app.engine.run('Build a replay explorer');assert.equal(session.meta.title,'Replay explorer');assert.equal(session.meta.autoNamed,true);assert.equal(requests.length,2);assert.match(requests[0].messages[0].content,/call session_title once/);assert.equal(session.messages.find(m=>m.role==='toolResult'&&m.toolName==='session_title').isError,false);
 assert.equal((await Session.load(session.meta.id,app.home)).meta.title,'Replay explorer');
});


test('directory header uses home-relative slash paths without shortening another user or a sibling home',async()=>{
 const {workspaceLabel}=await import('../src/logo.mjs'),{resolve}=await import('node:path');
 const home=resolve('Users','personal');assert.equal(workspaceLabel(join(home,'Coding','Psi'),home),'~/Coding/Psi');assert.equal(workspaceLabel(home,home),'~/');
 const sibling=home+'-other';assert.equal(workspaceLabel(join(sibling,'Psi'),home),join(sibling,'Psi'));
});
