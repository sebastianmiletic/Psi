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

test('OVERKILL waits for model delegation, uses distinct task names, and integrates executing worker reports',async t=>{
 let release,arrived;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrived=r);let parents=0,workers=0;const turns=new Map();
 const f=await setup(t,async p=>{
  const task=p.messages.find(m=>typeof m.content==='string'&&m.content.startsWith('Task from parent:'))?.content;
  if(task){workers++;const file=task.includes('counter.txt')?'counter.txt':'schema.txt',n=(turns.get(file)||0)+1;turns.set(file,n);return n===1?{call:{name:'write',args:{path:file,content:'verified '+file}}}:{text:'Implemented and verified '+file};}
  if(++parents===1){arrived();await gate;return{calls:[{name:'agent',args:{action:'spawn',profile:'preset',mode:'execute',name:'Build counter parser',prompt:'Implement counter.txt and verify it.'}},{name:'agent',args:{action:'spawn',profile:'preset',mode:'execute',name:'Fix replay schema',prompt:'Implement schema.txt and verify it.'}}]};}
  return{text:p.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Subagent reports ('))?'Integrated worker evidence.':'Continue while workers finish.'};
 });t.after(()=>release());
 await f.app.update({overkill:true,subagentConcurrency:2,agents:[{id:'preset',name:'Researcher',job:'Read existing evidence only.',model:'fixture/test',effort:'off',mode:'plan',maxSteps:5}]});
 const running=f.app.engine.run('Implement counter and schema changes');await ready;assert.equal((await f.app.agents.records()).length,0);assert.equal(f.ui.workerRows.size,0);release();await running;
 const records=await f.app.agents.records();assert.deepEqual(records.map(r=>r.name),['Build counter parser','Fix replay schema']);assert.equal(workers,4);assert.equal(f.session.state.workerDeliveries.length,2);assert.equal(f.session.totals.requests,workers+parents);assert.ok(f.session.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Subagent reports (')));
 for(const r of records){assert.ok(r.name.split(/\s+/).length<6);const spec=JSON.parse(await readFile(join(f.app.home,'sessions',r.sessionId,'worker.json')));assert.equal(JSON.parse(await readFile(join(f.app.home,'sessions',r.sessionId,'meta.json'))).title,r.name);assert.equal(spec.config.agentMode,'execute');assert.equal(spec.config.overkill,false);assert.equal(spec.config.subagentDepth,1);assert.doesNotMatch(spec.prompt,/Assigned role|advisory|Read existing evidence only/);}
 assert.equal(await readFile(join(f.root,'counter.txt'),'utf8'),'verified counter.txt');assert.equal(await readFile(join(f.root,'schema.txt'),'utf8'),'verified schema.txt');assert.equal(f.ui.subagentBar.render(100).length,0);const count=f.session.totals.requests;await f.app.agents.reports({wait:true});assert.equal(f.session.totals.requests,count);
});

test('a delegated plan worker stays read-only and a goal cannot finish before its report',async t=>{
 let children=0,parents=0,release;const gate=new Promise(r=>release=r);t.after(()=>release());
 const f=await fixture(t,async p=>{
  if(p.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Task from parent:'))){if(++children===1){await gate;return{call:{name:'write',args:{path:'forbidden.txt',content:'wrong'}}};}return{text:'Write denied; evidence inspected.'};}
  if(++parents===1)return{call:{name:'agent',args:{action:'spawn',name:'Verify completion evidence',mode:'plan',prompt:'Inspect evidence without changing files.'}}};
  release();return{call:{name:'finish',args:{summary:'Verified with worker evidence',evidence:['evidence.txt']}}};
 });
 const {writeFile}=await import('node:fs/promises');await writeFile(join(f.root,'evidence.txt'),'verified');await f.app.update({overkill:true,agents:[]});await f.app.engine.run('Verify the evidence',{loop:true});
 await assert.rejects(readFile(join(f.root,'forbidden.txt')));assert.equal(f.session.state.loopStatus,'complete');assert.equal(f.session.state.workerDeliveries.length,1);assert.ok(f.session.messages.some(m=>m.role==='toolResult'&&m.toolName==='finish'&&m.isError));assert.equal(f.session.messages.findLast(m=>m.role==='toolResult'&&m.toolName==='finish').isError,false);
});

test('double Escape stops model-delegated workers and active task names appear below usage',async t=>{
 let release;const gate=new Promise(r=>release=r);let started=0;
 const f=await setup(t,async p=>{
  if(!p.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Task from parent:'))&&!p.messages.some(m=>m.role==='tool'))return{call:{name:'agent',args:{action:'spawn',name:'Audit cancellation paths',prompt:'Inspect cancellation paths.'}}};
  started++;await gate;return{text:'Done'};
 });t.after(()=>release());await f.app.update({overkill:true,subagentConcurrency:1});const running=f.app.engine.run('Inspect cancellation paths');await until(()=>started>=2);
 const records=await f.app.agents.records();assert.equal(records.length,1);await until(()=>[...f.ui.workerRows.values()].some(r=>r.activity==='reasoning'));const lines=frame(f.ui);assert.ok(lines.findLastIndex(l=>l.includes('Audit cancellation paths'))>lines.findIndex(l=>l.includes('% left')));
 f.terminal.input('\x1b');f.terminal.input('\x1b');await running;await f.app.agents.stopAll({wait:true});assert.equal(f.app.engine.busy,false);assert.equal((await f.app.agents.status(records[0].id)).status,'cancelled');release();
});

test('enabling OVERKILL during inference exposes delegation without starting unassigned workers',async t=>{
 let release,arrived;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrived=r);
 const f=await fixture(t,async()=>{arrived();await gate;return{text:'Parent response.'};});t.after(()=>release());
 const running=f.app.engine.run('Check settings boundary');await ready;await f.app.engine.settings({overkill:true});release();await running;
 assert.equal((await f.app.agents.records()).length,0);assert.equal(f.requests.length,1);assert.ok(f.app.tools.entries.has('agent'));assert.equal(f.session.state.workerDeliveries,undefined);
});

test('completed worker findings and exact-once accounting survive a resumed parent session',async t=>{
 const f=await fixture(t,()=>({text:'Durable findings.'}));await f.app.update({overkill:true,agents:[{id:'one',name:'Research',job:'Read',mode:'plan',effort:'off',maxSteps:5}]});
 const r=await f.app.agents.spawn({profile:'one',name:'Inspect saved evidence',prompt:'Inspect saved evidence'});await f.app.agents.wait(r.id);
 const {Session}=await import('../src/session.mjs');const resumed=await Session.load(f.session.meta.id,f.app.home);await f.app.changeSession(resumed);
 const rows=await f.app.agents.reports({wait:true});assert.equal(rows.length,1);assert.match(rows[0].summary,/Durable findings/);assert.equal(resumed.totals.requests,1);await f.app.agents.delivered(rows);assert.deepEqual(await f.app.agents.reports({wait:true}),[]);assert.equal(resumed.totals.requests,1);
});


test('worker names must describe distinct tasks in fewer than six words, including concurrent spawn requests',async t=>{
 const f=await fixture(t,()=>({text:'Task completed.'}));await f.app.update({overkill:true,agents:[],subagentConcurrency:2});
 for(const name of[undefined,'','worker','Reviewer 2','one two three four five six','***'])await assert.rejects(f.app.agents.spawn({name,prompt:'Inspect evidence.'}),/name|Name|words/);
 assert.equal((await f.app.agents.records()).length,0);
 const results=await Promise.allSettled([f.app.agents.spawn({name:'Build replay explorer',prompt:'Build a replay explorer.'}),f.app.agents.spawn({name:'build replay explorer',prompt:'Duplicate task.'})]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.match(results[1].reason.message,/already named/);
 await f.app.agents.wait(results[0].value.id);await assert.rejects(f.app.agents.spawn({name:'Build replay explorer!',prompt:'Reuse a completed name.'}),/already named/);
 const next=await f.app.agents.spawn({name:'Fix fixture parser',prompt:'Fix the fixture parser.'});await f.app.agents.wait(next.id);assert.equal(next.profile,null);assert.equal(next.model,'fixture/test');assert.equal((await f.app.agents.records()).length,2);
});
