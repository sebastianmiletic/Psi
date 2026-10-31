import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences,visibleWidth } from '@earendil-works/pi-tui';
import { TerminalUI } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { modelLabel } from '../src/model-label.mjs';
import { fixture } from './helpers.mjs';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
async function setup(t,respond=()=>({text:'unused'})){const f=await fixture(t,respond),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();return{...f,ui,terminal};}
async function until(check){for(let i=0;i<150&&!await check();i++)await delay(10);assert.ok(await check());}

test('model labels omit provider routes and model search uses the actual composer with draft restoration',async t=>{
 const f=await setup(t),{ui,terminal}=f;
 assert.equal(modelLabel('openai-codex/gpt-5.6-luna'),'5.6 luna');assert.equal(modelLabel({id:'claude-opus-4-6'}),'opus 4 6');assert.equal(modelLabel({id:'global.openai.gpt-5.6-luna'}),'5.6 luna');assert.equal(modelLabel({id:'us.anthropic.claude-opus-4-6'}),'opus 4 6');
 ui.editor.setText('Preserve this draft');
 const items=[{value:'openai-codex/gpt-5.6-luna',label:'5.6 luna',search:'5.6 luna openai-codex'},{value:'other/gpt-5.6-sol',label:'5.6 sol',search:'5.6 sol other'},{value:'duplicate/gpt-5.6-luna',label:'5.6 luna',search:'5.6 luna duplicate'}];
 let menu=ui.modelMenu(items);terminal.input('5.6 luna');let lines=frame(ui);assert.equal(ui.editor.getText(),'5.6 luna');assert.equal(lines.filter(l=>l.includes('5.6 luna')).length,2);assert.match(lines[27],/5.6 luna/);assert.match(lines.join('\n'),/Model/);assert.doesNotMatch(lines.join('\n'),/openai-codex|5.6 sol|Search:|filter/);
 terminal.input('\r');assert.equal(await menu,'openai-codex/gpt-5.6-luna');assert.equal(ui.editor.getText(),'Preserve this draft');assert.equal(f.requests.length,0);
 menu=ui.modelMenu(items);terminal.input('no matching model');assert.match(frame(ui).join('\n'),/No matching/);terminal.input('\x1b');assert.equal(await menu,null);assert.equal(ui.editor.getText(),'Preserve this draft');
 menu=ui.modelMenu(items);terminal.input('\x1b[B');terminal.input('\r');assert.equal(await menu,'other/gpt-5.6-sol');
 f.app.engine.config.model='openai-codex/gpt-5.6-luna';assert.match(stripTerminalSequences(ui.footer.render(100)[0]),/5.6 luna/);assert.doesNotMatch(stripTerminalSequences(ui.footer.render(100)[0]),/codex|gpt-/);f.app.engine.config.model='fixture/test';
});

test('/model passes only model names to its picker while retaining exact provider routing',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let seen;
 f.app.ui={modelMenu:async(items,query)=>{seen={items,query};return null;},stop(){}};
 await f.app.selectModel('5.6 luna');const item=seen.items.find(i=>i.value==='openai-codex/gpt-5.6-luna');assert.ok(item);assert.equal(item.label,'5.6 luna');assert.equal(item.description,undefined);assert.equal(seen.query,'5.6 luna');assert.equal(f.requests.length,0);
});

test('OVERKILL is right aligned on the effort line, clickable, and keeps its keyboard toggle',async t=>{
 const {ui,terminal}=await setup(t);const menu=ui.effortMenu({levels:['off','low','medium','high','xhigh','max'],effort:'medium',overkill:false});
 let lines=frame(ui),y=lines.findIndex(l=>l.includes('OVERKILL'));assert.ok(lines[y].indexOf('max')<lines[y].indexOf('OVERKILL'));assert.ok(lines[y].indexOf('OVERKILL')>80);
 terminal.input(`\x1b[<0;94;${y+1}M`);terminal.input(`\x1b[<0;94;${y+1}m`);assert.equal(ui.effortPreview.overkill,true);
 for(const columns of[28,50,100]){terminal.resize(columns,32);lines=frame(ui);assert.ok(lines.some(l=>l.includes('OVERKILL')));assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=columns));}
 terminal.input('\t');assert.equal(ui.effortPreview.overkill,false);terminal.input('\x1b');await menu;
});

test('OVERKILL starts bounded task-named workers automatically and integrates reports before the final response',async t=>{
 let parentBeforeReports=0,parentAfterReports=0,workers=0;
 const f=await setup(t,p=>{
  const child=p.messages.some(m=>typeof m.content==='string'&&m.content.includes('Automatic advisory task.'));
  if(child){workers++;return{text:'Check bounds and preserve the baseline; fixture evidence verified.'};}
  if(p.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Subagent reports ('))){parentAfterReports++;return{text:'Integrated the worker evidence into the final result.'};}
  parentBeforeReports++;return{text:'Initial inspection complete.'};
 });
 await f.app.update({overkill:true,subagentConcurrency:2,agents:[{id:'research',name:'Research',job:'Inspect code',model:'fixture/test',effort:'off',mode:'plan',maxSteps:5},{id:'review',name:'Review',job:'Review risks',model:'fixture/test',effort:'off',mode:'execute',maxSteps:5},{id:'extra',name:'Extra',job:'Extra check',effort:'off',mode:'plan',maxSteps:5}]});
 await f.app.engine.run('Inspect baseline behaviour');const records=await f.app.agents.records();assert.equal(records.length,2);assert.equal(workers,2);assert.equal(parentAfterReports,1);assert.ok(parentBeforeReports<=1);assert.equal(f.session.totals.requests,workers+parentAfterReports+parentBeforeReports);
 assert.equal(f.session.state.workerDeliveries.length,2);assert.equal(f.session.messages.filter(m=>typeof m.content==='string'&&m.content.startsWith('Subagent reports (')).length,1);
 for(const r of records){assert.match(r.name,/Inspect baseline behaviour/);assert.equal(r.automatic,true);const spec=JSON.parse(await readFile(join(f.app.home,'sessions',r.sessionId,'worker.json')));assert.equal(spec.config.agentMode,'plan');assert.equal(spec.config.overkill,false);assert.equal(spec.config.subagentDepth,1);assert.equal((await f.app.agents.status(r.id)).status,'completed');}
 const lines=frame(f.ui),editor=lines.findIndex(l=>l.includes('EXECUTE'));assert.equal(f.ui.subagentBar.render(100).length,0);assert.doesNotMatch(lines.slice(editor+1).join('\n'),/Inspect baseline behaviour|completed/);assert.doesNotMatch(lines.slice(editor+1).join('\n'),/fixture\//);
 const count=f.session.totals.requests;await f.app.agents.reports({wait:true});assert.equal(f.session.totals.requests,count);
});

test('automatic subagents cannot write project files, and a loop cannot finish before their reports',async t=>{
 let childTurns=0,finishAttempts=0;
 const f=await fixture(t,p=>{
  const child=p.messages.some(m=>typeof m.content==='string'&&m.content.includes('Automatic advisory task.'));
  if(child)return ++childTurns===1?{call:{name:'write',args:{path:'forbidden.txt',content:'wrong'}}}:{text:'Write was denied; inspected the plan.'};
  finishAttempts++;return {call:{name:'finish',args:{summary:'Verified after advisory review',evidence:['evidence.txt']}}};
 });
 const {writeFile}=await import('node:fs/promises');await writeFile(join(f.root,'evidence.txt'),'verified');
 await f.app.update({overkill:true,subagentConcurrency:1,agents:[{id:'one',name:'Reviewer',job:'Inspect changes',mode:'execute',effort:'off',maxSteps:5}]});await f.app.engine.run('Review evidence',{loop:true});
 await assert.rejects(readFile(join(f.root,'forbidden.txt')));assert.equal(f.session.state.loopStatus,'complete');assert.equal(f.session.state.workerDeliveries.length,1);assert.ok(finishAttempts>=1);const finish=f.session.messages.findLast(m=>m.role==='toolResult'&&m.toolName==='finish');assert.equal(finish.isError,false);
});

test('double Escape stops automatic workers and new worker activity appears below the input',async t=>{
 let release;const gate=new Promise(r=>release=r);let started=0;
 const f=await setup(t,async()=>{started++;await gate;return{text:'Done'};});t.after(()=>release());
 await f.app.update({overkill:true,subagentConcurrency:1,agents:[{id:'one',name:'Research',job:'Read the project',mode:'plan',effort:'off',maxSteps:5}]});
 const running=f.app.engine.run('Inspect cancellation paths');await until(async()=>started>=2);
 const records=await f.app.agents.records();assert.equal(records.length,1);await until(()=>[...f.ui.workerRows.values()].some(r=>r.activity==='reasoning'));
 f.terminal.input('\x1b');f.terminal.input('\x1b');await running;await f.app.agents.stopAll({wait:true});assert.equal(f.app.engine.busy,false);assert.equal((await f.app.agents.status(records[0].id)).status,'cancelled');release();
});

test('enabling OVERKILL during inference starts subagents before the turn can finish',async t=>{
 let release,arrived;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrived=r);let workerCalls=0,parentCalls=0;
 const f=await fixture(t,async p=>{
  if(p.messages.some(m=>typeof m.content==='string'&&m.content.includes('Automatic advisory task.'))){workerCalls++;return{text:'Checked the task.'};}
  if(++parentCalls===1){arrived();await gate;}return{text:'Parent response.'};
 });t.after(()=>release());
 await f.app.update({agents:[{id:'one',name:'Research',job:'Inspect task',mode:'plan',effort:'off',maxSteps:5}]});
 const running=f.app.engine.run('Check settings boundary');await ready;await f.app.engine.settings({overkill:true});release();await running;
 assert.equal(workerCalls,1);assert.equal((await f.app.agents.records()).length,1);assert.equal(f.session.state.workerDeliveries.length,1);assert.equal(parentCalls,2);
});

test('completed worker findings and exact-once accounting survive a resumed parent session',async t=>{
 const f=await fixture(t,()=>({text:'Durable findings.'}));await f.app.update({overkill:true,agents:[{id:'one',name:'Research',job:'Read',mode:'plan',effort:'off',maxSteps:5}]});
 const r=await f.app.agents.spawn({profile:'one',prompt:'Inspect saved evidence',automatic:true,runId:'saved'});await f.app.agents.wait(r.id);
 const {Session}=await import('../src/session.mjs');const resumed=await Session.load(f.session.meta.id,f.app.home);await f.app.changeSession(resumed);
 const rows=await f.app.agents.reports({wait:true});assert.equal(rows.length,1);assert.match(rows[0].summary,/Durable findings/);assert.equal(resumed.totals.requests,1);await f.app.agents.delivered(rows);assert.deepEqual(await f.app.agents.reports({wait:true}),[]);assert.equal(resumed.totals.requests,1);
});
