import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {fixture} from './helpers.mjs';
import {MemoryTerminal} from './terminal.mjs';
import {TerminalUI} from '../src/ui.mjs';
import {UserMessage} from '../src/message-ui.mjs';
import {Session} from '../src/session.mjs';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
const result=(text,isError=false)=>({isError,content:[{type:'text',text}]});
async function setup(t){const f=await fixture(t,()=>({text:'Completed the requested review.'})),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();return{...f,ui,terminal};}
function call(ui,id,name,args,output='Done',failed=false){const c={id,name,arguments:args};ui.event({type:'tool_start',call:c});ui.event({type:'tool_end',call:c,result:result(output,failed)});}

test('long prompts collapse visually while model input and durable history stay exact',async t=>{
 const f=await setup(t),prompt=Array.from({length:80},(_,i)=>`Requirement ${i}: preserve every detail.`).join('\n');
 await f.app.submit(prompt);f.ui.editor.setText('Keep my draft');
 let lines=frame(f.ui);assert.match(lines.join('\n'),/Full prompt/);assert.doesNotMatch(lines.join('\n'),/Requirement 79/);
 assert.ok(f.requests[0].messages.some(m=>m.role==='user'&&m.content===prompt));
 const before=f.requests.length;f.terminal.input('\x10');assert.equal(f.ui.lastUser.expanded,true);assert.match(f.ui.lastUser.render(100).map(stripTerminalSequences).join('\n'),/Requirement 79/);assert.equal(f.ui.editor.getText(),'Keep my draft');
 f.terminal.input('\x10');assert.equal(f.ui.lastUser.expanded,false);f.ui.scroll.scrollToEnd();lines=frame(f.ui);
 const y=lines.findIndex(l=>l.includes('Full prompt'));assert.ok(y>=0);
 f.terminal.input(`\x1b[<0;8;${y+1}M`);f.terminal.input(`\x1b[<0;8;${y+1}m`);assert.equal(f.ui.lastUser.expanded,true);assert.equal(f.ui.editor.getText(),'Keep my draft');
 const restored=await Session.load(f.session.meta.id,f.app.home);assert.equal(restored.visibleConversation()[0].content,prompt);
 assert.equal(f.requests.length,before);assert.ok((await readFile(join(f.session.dir,'events.jsonl'),'utf8')).includes('Requirement 79'));
});

test('prompt disclosure handles short messages, wide Unicode and narrow resizes',async t=>{
 const f=await setup(t);f.ui.user('Short prompt',{animate:false});frame(f.ui);assert.equal(f.ui.lastUser.toggle(),false);assert.doesNotMatch(f.ui.lastUser.render(40).join(''),/Full prompt/);
 const message=new UserMessage(f.ui,'Ψ 你好 🧪 '.repeat(500),{animate:false});
 for(const width of[20,28,60,100]){assert.ok(message.render(width).every(l=>visibleWidth(l)<=width));assert.equal(message.collapsible,true);message.toggle();assert.ok(message.render(width).every(l=>visibleWidth(l)<=width));message.toggle();}
});

test('short prompts never acquire a disclosure from wrapping or newlines',async t=>{
 const f=await setup(t),prompts=['Fix the prompt display and preserve every detail. '.repeat(5),Array.from({length:10},(_,i)=>'Step '+i).join('\n'),'你好 🧪 Ψ '.repeat(35),'x'.repeat(1800)];
 for(const prompt of prompts){const message=new UserMessage(f.ui,prompt,{animate:false});for(const width of[12,20,28,68,100]){const lines=message.render(width).map(stripTerminalSequences);assert.equal(message.collapsible,false);assert.equal(message.toggle(),false);assert.doesNotMatch(lines.join('\n'),/Full prompt|Hide prompt/);assert.ok(lines.every(line=>visibleWidth(line)<=width));assert.ok(lines.length>1);}}
 const long=new UserMessage(f.ui,'x'.repeat(1801),{animate:false});long.render(100);assert.equal(long.collapsible,true);assert.equal(long.toggle(),true);
 f.ui.user(prompts[0],{animate:false});f.ui.editor.setText('Unchanged draft');for(const columns of[28,100]){f.terminal.resize(columns,32);frame(f.ui);assert.equal(f.ui.lastUser.collapsible,false);f.terminal.input('\x10');assert.equal(f.ui.lastUser.expanded,false);}assert.equal(f.ui.editor.getText(),'Unchanged draft');assert.equal(f.requests.length,0);
});

test('compact activity hides routine successes, exposes errors, and reveals details without inference',async t=>{
 const f=await setup(t);
 call(f.ui,'read','read',{path:'source.mjs'},'PRIVATE READ CONTENT');call(f.ui,'search','search',{pattern:'secret pattern'},'PRIVATE SEARCH CONTENT');call(f.ui,'shell','bash',{command:'wc -l source.mjs'},JSON.stringify({status:'completed',exitCode:0,output:'PRIVATE SHELL CONTENT'}));
 assert.doesNotMatch(frame(f.ui).join('\n'),/PRIVATE|source.mjs|secret pattern|Explored/);
 f.terminal.input('\x14');assert.match(frame(f.ui).join('\n'),/PRIVATE READ CONTENT/);assert.match(frame(f.ui).join('\n'),/PRIVATE SHELL CONTENT/);f.terminal.input('\x14');
 call(f.ui,'failed','read',{path:'missing.txt'},'ENOENT: missing fixture',true);assert.match(frame(f.ui).join('\n'),/missing.txt.*failed/);assert.match(frame(f.ui).join('\n'),/ENOENT/);
 call(f.ui,'delete','bash',{command:'rm scratch.txt'},JSON.stringify({status:'completed',exitCode:0,output:''}));assert.match(frame(f.ui).join('\n'),/Ran rm scratch.txt/);
 call(f.ui,'malformed','bash',null,'Invalid tool arguments',true);assert.match(frame(f.ui).join('\n'),/Invalid tool arguments/);
 assert.equal(f.requests.length,0);
});

test('file changes, builds, launches, worker reports and final review remain visible',async t=>{
 const f=await setup(t);
 call(f.ui,'write','write',{path:'src/a.cpp',content:'new'},'Wrote source');call(f.ui,'edit','edit',{path:'src/a.cpp',old:'old',new:'new'},'Updated source');call(f.ui,'write-b','write',{path:'src/b.cpp',content:'new'},'Wrote source');
 assert.match(frame(f.ui).join('\n'),/Updated 2 files/);
 call(f.ui,'build','bash',{command:'npm test'},JSON.stringify({status:'completed',exitCode:0,output:'Detailed test output'}));assert.match(frame(f.ui).join('\n'),/Ran npm test/);assert.doesNotMatch(frame(f.ui).join('\n'),/Detailed test output/);
 f.ui.event({type:'agent_started',agent:{id:'worker',name:'Verify cache boundaries',group:'Cache correctness',model:'fixture/test'}});
 f.ui.event({type:'agent_finished',agent:{id:'worker',name:'Verify cache boundaries',status:'completed',result:{summary:'Boundary assertions passed.'}}});
 f.ui.event({type:'final_response',text:'Verified the implementation and reviewed the evidence.'});
 const text=frame(f.ui).join('\n');assert.match(text,/Launched subagent Verify cache boundaries/);assert.match(text,/Subagent report Verify cache boundaries/);assert.match(text,/Boundary assertions passed/);assert.match(text,/Verified the implementation/);assert.equal(f.ui.workerRows.size,0);
 assert.equal(f.requests.length,0);
});

test('hidden routine activity cannot evict the prompt and review from the bounded transcript',async t=>{
 const f=await setup(t);f.ui.user('Keep the original task',{animate:false});
 for(let i=0;i<250;i++){f.ui.event({type:'request_start'});call(f.ui,'read-'+i,'read',{path:'file-'+i},'Routine output');f.ui.event({type:'request_end'});}
 f.ui.markdown('Review complete.');assert.ok(f.ui.transcript.children.length<=100);assert.match(frame(f.ui).join('\n'),/Keep the original task/);assert.match(frame(f.ui).join('\n'),/Review complete/);assert.equal(f.requests.length,0);
});

test('full tool activity is a live display setting and does not change inference history',async t=>{
 const f=await setup(t);call(f.ui,'read','read',{path:'debug.txt'},'Debug evidence');assert.doesNotMatch(frame(f.ui).join('\n'),/debug.txt/);
 f.terminal.input('\x14');f.terminal.input('\x14');const before=JSON.stringify(f.session.messages);f.app.engine.busy=true;await f.app.update({toolActivity:'full'});f.app.engine.busy=false;
 assert.match(frame(f.ui).join('\n'),/debug.txt/);assert.equal(f.app.engine.pendingSettings.toolActivity,undefined);assert.equal(JSON.stringify(f.session.messages),before);assert.equal(f.requests.length,0);
});
