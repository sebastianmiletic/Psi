import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences,visibleWidth } from '@earendil-works/pi-tui';
import { TerminalUI,commands } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { fixture } from './helpers.mjs';
import { applicableQuota } from '../src/usage.mjs';
import { accentColor } from '../src/theme.mjs';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
async function setup(t){const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32);let now=0;const ui=new TerminalUI(f.app,{terminal,now:()=>now});f.app.ui=ui;t.after(()=>ui.stop());ui.start();return{...f,terminal,ui,time:n=>now=n};}

test('effort uses a dedicated staged slider and Escape cancels without stopping the active run',async t=>{
 const f=await setup(t),{ui,terminal}=f;let stopped=0;f.app.engine.busy=true;const stop=f.app.engine.stop.bind(f.app.engine);f.app.engine.stop=()=>{stopped++;stop();};
 let menu=ui.effortMenu({levels:['low','medium','high'],effort:'medium',overkill:false});assert.doesNotMatch(frame(ui).join('\n'),/Search:/);assert.match(frame(ui).join('\n'),/OVERKILL/);assert.match(frame(ui).slice(0,6).join('\n'),/Psi|Ψ PSI/);assert.doesNotMatch(frame(ui).join('\n'),/Choose how|Balanced reasoning|Configured workers/);
 terminal.input('\x1b[C');terminal.input('\t');assert.deepEqual(ui.effortPreview,{effort:'high',overkill:true});assert.equal(f.app.engine.config.overkill,false);terminal.input('\x1b');assert.equal(await menu,null);assert.equal(stopped,0);assert.equal(ui.pending,null);assert.equal(ui.effortPreview,null);assert.ok(!ui.motionTimer);
 menu=ui.effortMenu({levels:['low','medium','high'],effort:'medium',overkill:false});terminal.input('\x1b[C');terminal.input('\t');terminal.input('\r');assert.deepEqual(await menu,{effort:'high',overkill:true});
 terminal.resize(28,18);menu=ui.effortMenu({levels:['off','minimal','low','medium','high','xhigh'],effort:'medium',overkill:false});const small=frame(ui).join('\n');assert.match(small,/medium/);assert.match(small,/↵ · esc/);terminal.input('\x1b');await menu;f.app.engine.busy=false;
});
test('OVERKILL flows in the chosen accent without moving slash commands, and respects disabled animation',async t=>{
 const f=await setup(t),{ui}=f;f.app.engine.config.accent='rose';f.app.engine.config.overkill=true;ui.syncMotion();ui.editor.setText('/model');let lines=frame(ui);const before=ui.tui.getScreenLines();assert.equal(lines.find(l=>l.includes('/model')).indexOf('/model'),1);assert.ok(ui.motionTimer);
 const oldHeader=ui.header.render(100),oldBar=ui.progressBar.render(100);f.time(520);frame(ui);assert.notDeepEqual(before,ui.tui.getScreenLines());assert.notDeepEqual(oldHeader,ui.header.render(100));assert.notDeepEqual(oldBar,ui.progressBar.render(100));assert.equal(ui.editor.getText(),'/model');
 f.app.engine.config.animations=false;ui.syncMotion();frame(ui);const stable=ui.tui.getScreenLines();f.time(1000);frame(ui);assert.deepEqual(stable,ui.tui.getScreenLines());assert.equal(ui.motionTimer,null);
 await f.app.setMode('plan');assert.equal(ui.transcript.children.length,0);lines=frame(ui);assert.equal(lines.find(l=>l.includes('/model')).indexOf('/model'),1);
});
test('the accent quota bar shows five-hour capacity with only weekly quota beside the account',async t=>{
 const f=await setup(t),{ui}=f;f.app.engine.config.accent='rose';f.app.activeAccount={name:'Personal',type:'oauth',billingMode:'subscription'};
 f.app.activeUsage={limitsAt:new Date().toISOString(),limits:[{kind:'quota',label:'7d',usedPercent:40,resetAt:9999999999},{kind:'quota',label:'5h',usedPercent:25,resetAt:9999999999}]};
 let bar=ui.progressBar.render(100)[0];const c=accentColor({accent:'rose'});assert.ok(bar.includes(`\x1b[38;2;${c.r};${c.g};${c.b}m`));assert.match(stripTerminalSequences(bar),/75% left/);assert.match(stripTerminalSequences(ui.footer.render(100)[1]),/7d 60% left/);assert.match(stripTerminalSequences(ui.footer.render(100)[1]),/Personal · 7d 60% left/);assert.doesNotMatch(stripTerminalSequences(ui.footer.render(100)[1]),/5h|75%/);assert.doesNotMatch(stripTerminalSequences(bar),/5h|7d|used/);
 f.app.activeUsage.limits[1].usedPercent=100;assert.doesNotMatch(stripTerminalSequences(ui.progressBar.render(100)[0]),/█/);assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/0% left/);f.app.activeUsage.limits[1].usedPercent=0;assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/█{30}.*100% left/);
 f.app.activeUsage.limits[1].resetAt=1;assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/60% left/);f.app.activeUsage.limits=[];assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/Usage unavailable/);assert.equal(applicableQuota(null),null);
});
test('stats opens a tabbed UI, preserves the draft and closes with one Escape without chat output',async t=>{
 const f=await setup(t),{ui,terminal}=f;ui.editor.setText('/model');const count=ui.transcript.children.length,menu=f.app.submit('/stats');await delay(60);let lines=frame(ui);assert.match(lines.join('\n'),/Stats/);assert.match(lines.join('\n'),/Tokens/);assert.match(lines.join('\n'),/Time/);assert.equal(ui.tui.hasOverlay(),false);assert.match(lines.slice(0,6).join('\n'),/Psi|Ψ PSI/);assert.ok(lines.findIndex(l=>l.includes('Stats'))>6);terminal.input('\t');assert.match(frame(ui).join('\n'),/\[Week\]/);
 for(const [columns,rows]of[[68,24],[28,18],[100,32]]){terminal.resize(columns,rows);const screen=frame(ui);assert.match(screen.join('\n'),/\[Week\]/);assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=columns));}
 terminal.input('\x1b');await menu;assert.equal(ui.pending,null);assert.equal(ui.tui.hasOverlay(),false);assert.equal(ui.editor.getText(),'/model');assert.equal(ui.transcript.children.length,count);assert.equal(f.requests.length,0);
});
test('queued mode and effort changes remain out of the conversation',async t=>{
 const f=await setup(t);f.app.engine.busy=true;await f.app.engine.settings({agentMode:'plan'});await f.app.engine.settings({effort:'off',overkill:true});assert.equal(f.ui.transcript.children.length,0);assert.equal(f.session.messages.length,0);f.app.engine.busy=false;
});

test('tool names stay in a compact paged panel, while removed slash commands are rejected',async t=>{
 const {app,ui,terminal}=await setup(t);const tools=Array.from({length:50},(_,i)=>({name:'tool_'+i,description:'Long description that should stay out of the panel'}));
 const menu=ui.toolsMenu(tools);const screens=[];for(let i=0;i<4;i++){screens.push(frame(ui).join('\n'));terminal.input('\x1b[C');}assert.match(screens.join('\n'),/tool_49/);assert.doesNotMatch(screens.join('\n'),/Long description/);assert.match(screens[0],/Psi/);terminal.input('\x1b');await menu;
 for(const name of ['agents','provider','cd','summary-model','checkpoint'])await assert.rejects(app.submit('/'+name),/removed/);
});

test('reload reads disk settings, rebuilds tools and accounts, and preserves session state and draft',async t=>{
 const {app,ui,session,root,config,requests}=await setup(t);const {writeFile,mkdir,realpath}=await import('node:fs/promises');const {join}=await import('node:path');
 const extra=join(root,'extra');await mkdir(extra);await app.submit('/directory '+extra);
 await session.message({role:'user',content:'Saved context',timestamp:Date.now()});await session.event({type:'state',state:{loopGoal:'Unfinished goal',queuedMessages:['Next task']}});
 await app.update({accent:'rose'});await writeFile(join(app.home,'config.json'),JSON.stringify({...config,accent:'cyan',checkForUpdates:false}));
 const oldEngine=app.engine,oldTools=app.tools,oldRegistry=app.registry;let closed=false;const close=oldTools.close.bind(oldTools);oldTools.close=async()=>{closed=true;await close();};ui.editor.setText('Preserve draft');
 assert.ok(commands.some(c=>c.name==='reload'));assert.ok(commands.some(c=>c.name==='refresh'));await app.submit('/reload');assert.notEqual(app.engine,oldEngine);assert.notEqual(app.registry,oldRegistry);assert.equal(closed,true);assert.equal(app.engine.config.accent,'cyan');assert.equal(app.tools.config.accent,'cyan');assert.equal(app.session.meta.id,session.meta.id);assert.equal(app.session.messages[0].content,'Saved context');assert.equal(app.session.state.loopGoal,'Unfinished goal');assert.deepEqual(app.engine.queue,['Next task']);assert.ok((await app.tools.policy.roots()).includes(await realpath(extra)));assert.equal(ui.editor.getText(),'Preserve draft');assert.equal(requests.length,0);
 assert.ok(app.tools.definitions().some(t=>t.name==='read'));assert.equal(app.engine.model.id,'test');
});

test('an active reload requires confirmation; Escape keeps the run and acceptance stops without restarting inference',async t=>{
 let release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r);
 const f=await fixture(t,async()=>{ready();await gate;return{text:'Finished'};});t.after(()=>release());
 const terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();
 const {writeFile}=await import('node:fs/promises');const {join}=await import('node:path');await writeFile(join(f.app.home,'config.json'),JSON.stringify({...f.config,checkForUpdates:false}));
 const running=f.app.submit('Do work');await started;const old=f.app.engine;
 let reload=f.app.submit('/reload');frame(ui);assert.match(frame(ui).join('\n'),/Stop AI and reload/);terminal.input('\x1b');assert.equal(await reload,false);assert.equal(old.busy,true);assert.equal(old.controller.signal.aborted,false);
 reload=f.app.submit('/refresh');frame(ui);terminal.input('\x1b[B');terminal.input('\r');await reload;await running;
 assert.equal(old.busy,false);assert.notEqual(f.app.engine,old);assert.equal(f.app.engine.busy,false);assert.equal(f.requests.length,1);release();
});

test('reload also asks before interrupting an independently running subagent',async t=>{
 let release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r);
 const f=await fixture(t,async()=>{ready();await gate;return{text:'Worker finished'};});t.after(()=>release());
 const terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();
 await f.app.update({overkill:true,agents:[{id:'one',name:'One',job:'Inspect',model:'fixture/test',effort:'off',mode:'plan',maxSteps:5}]});
 const worker=await f.app.agents.spawn({profile:'one',name:'Inspect active task',prompt:'Inspect'});await started;assert.equal(f.app.engine.busy,false);
 try{
  const reload=f.app.submit('/refresh');for(let i=0;i<100&&!ui.pending;i++)await delay(10);assert.ok(ui.pending);terminal.input('\x1b');assert.equal(await reload,false);assert.equal((await f.app.agents.status(worker.id)).status,'running');
 }finally{release();await f.app.agents.stopAll({wait:true});}
});

test('compact pickers search the visible label as well as the stored setting key',async t=>{
 const {ui,terminal}=await setup(t),items=[{value:'summaryModel',label:'Compaction model'},{value:'animations',label:'Motion'}];
 for(const [query,value]of[['compaction','summaryModel'],['motion','animations']]){
  const menu=ui.choose('Settings',items);terminal.input(query);const screen=frame(ui).join('\n');assert.doesNotMatch(screen,/No matching/);assert.match(screen,new RegExp(items.find(i=>i.value===value).label));terminal.input('\r');assert.equal(await menu,value);
 }
});
