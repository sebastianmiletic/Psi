import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {fixture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {TerminalUI} from '../src/ui.mjs';
import {MemoryTerminal} from './terminal.mjs';
import {stripTerminalSequences} from '@earendil-works/pi-tui';
import {QuotaMonitor} from '../src/quota.mjs';
const report='The parser now preserves explicit nulls.\n\n### What changed\n\n1. Corrected precedence.\n\n### Verification\n\n- Public fixtures passed.\n\n### Important limitations\n\nNo live service was deployed.';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};

test('verified finish publishes the complete final review without another request and restores/exports it once',async t=>{
 const f=await fixture(t,()=>({call:{name:'finish',args:{summary:'Parser fixed.',report,evidence:['proof.txt']}}}));await writeFile(join(f.root,'proof.txt'),'verified');
 await f.app.engine.run('Fix the parser',{loop:true});assert.equal(f.requests.length,1);assert.equal(f.events.filter(e=>e.type==='final_response').length,1);assert.equal(f.events.find(e=>e.type==='final_response').text,report);assert.equal(f.session.conversation.at(-1).content[0].text,report);
 const saved=await Session.load(f.session.meta.id,f.app.home);assert.equal(saved.conversation.at(-1).content[0].text,report);await f.app.changeSession(saved);await f.app.engine.recoverReview();assert.equal(f.events.filter(e=>e.type==='final_response').length,1);
 const exported=await f.app.exportMarkdown();assert.equal(exported.split(report).length-1,1);assert.match(exported,/What changed/);
});

test('finish without report receives one text-only final request; later actions are skipped',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{calls:[{name:'finish',args:{summary:'Done',evidence:['proof.txt']}},{name:'write',args:{path:'late.txt',content:'must not run'}}]}:{text:report});await writeFile(join(f.root,'proof.txt'),'verified');
 await f.app.engine.run('Complete work',{loop:true});assert.equal(f.requests.length,2);assert.equal(f.requests[1].tool_choice,'none');assert.deepEqual(f.requests[1].tools,f.requests[0].tools);await assert.rejects(readFile(join(f.root,'late.txt')));assert.equal(f.session.conversation.at(-1).content[0].text,report);assert.ok(f.session.messages.some(m=>m.role==='toolResult'&&m.toolName==='write'&&m.isError));
});

test('failed completion never publishes the supplied success review',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{call:{name:'finish',args:{summary:'Unverified',report,evidence:['missing.txt']}}}:{text:'Blocked: the required evidence is missing.'});
 await f.app.engine.run('Check completion');assert.equal(f.events.filter(e=>e.type==='final_response').length,0);assert.equal(f.session.state.completed,undefined);assert.equal(f.session.messages.find(m=>m.role==='toolResult').isError,true);
});

test('unpublished saved report recovers exactly once without inference',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.event({type:'state',state:{completed:{summary:'Done',report,evidence:['proof.txt'],completionId:'saved-completion'}}});
 await f.app.engine.recoverReview();await f.app.engine.recoverReview();assert.equal(f.requests.length,0);assert.equal(f.events.filter(e=>e.type==='final_response').length,1);assert.equal((await Session.load(f.session.meta.id,f.app.home)).state.reviewedCompletionId,'saved-completion');
});

test('a plan progress tool no longer ends the run before the model explains its plan',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{call:{name:'progress',args:{steps:[{title:'Inspect',status:'complete'},{title:'Implement',status:'pending'}],update:'I checked the parser and will outline the repair.'}}}:{text:'### Plan\n\n1. Correct precedence.\n2. Verify explicit nulls.'});await f.app.update({agentMode:'plan'});
 await f.app.engine.run('Plan the repair');assert.equal(f.requests.length,2);assert.match(f.session.conversation.at(-1).content[0].text,/### Plan/);assert.ok(f.events.some(e=>e.type==='progress'));
});

test('submitting a message returns to the bottom, while ordinary updates do not override manual scrolling',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;ui.start();t.after(()=>ui.stop());
 for(let i=0;i<40;i++)ui.note('Earlier content '+i);frame(ui);ui.scroll.scrollToStart();assert.equal(ui.scroll.isFollowingEnd,false);ui.markdown('Interim update');frame(ui);assert.equal(ui.scroll.isFollowingEnd,false);
 f.app.engine.busy=true;terminal.input('New queued question');terminal.input('\r');const lines=frame(ui);assert.equal(ui.scroll.isFollowingEnd,true);assert.match(lines.join('\n'),/New queued question/);assert.deepEqual(f.app.engine.queue,['New queued question']);f.app.engine.busy=false;
});

test('quota checks use short cache intervals, preserve decimals, and never label task estimates as subscription capacity',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let now=1000000,calls=0;const a={id:'a',provider:'openai-codex',type:'oauth'};
 f.app.registry.forAccount=()=>({getAuth:async()=>true});f.app.registry.accounts.store=()=>({read:async()=>({access:'secret',accountId:'a'})});
 const q=new QuotaMonitor(f.app.registry,{quotaRefreshSeconds:15},f.app.home,{now:()=>now,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:12.34,reset_at:now/1000+1000}}}),{status:200});}});
 const first=await q.refresh(a);now+=14000;await q.refresh(a);assert.equal(calls,1);now+=1000;await q.refresh(a);assert.equal(calls,2);await q.refresh(a,{force:true});assert.equal(calls,3);
 const ui=new TerminalUI(f.app,{terminal:new MemoryTerminal(100,32)});t.after(()=>ui.stop());f.app.activeAccount=a;f.app.activeUsage={...first,quotaCheckedAt:new Date().toISOString(),limits:[{kind:'quota',label:'5h',usedPercent:12.34,resetAt:Date.now()/1000+1000}]};assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/87.7% left/);
 f.app.activeUsage.quotaError='offline';assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/cached/);f.app.activeUsage={limits:[]};assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/Usage unavailable/);assert.doesNotMatch(stripTerminalSequences(ui.progressBar.render(100)[0]),/Goal|100%/);
});


test('a quota refresh for the previous account cannot replace the newly selected account display',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let selected={id:'one',provider:'fixture',type:'oauth',name:'One'},release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r);t.after(()=>release());
 f.app.registry.accounts.selected=async()=>selected;f.app.engine.quota.refresh=async()=>{ready();await gate;return{limits:[{kind:'quota',label:'5h',usedPercent:99}]};};
 const refreshing=f.app.refreshAccount({live:true,force:true});await started;selected={id:'two',provider:'fixture',type:'oauth',name:'Two'};f.app.activeAccount=selected;f.app.activeUsage={limits:[]};release();await refreshing;assert.equal(f.app.activeAccount.id,'two');assert.deepEqual(f.app.activeUsage.limits,[]);
});
