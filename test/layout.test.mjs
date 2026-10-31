import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { TerminalUI } from '../src/ui.mjs';
import { renderPsi } from '../src/logo.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { fixture } from './helpers.mjs';

function frame(ui) { ui.tui.renderNow(); return ui.tui.getScreenLines().map(stripTerminalSequences); }

test('prompt stays at the bottom on startup, transcript growth, menus and terminal resize', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const terminal = new MemoryTerminal(100, 32), ui = new TerminalUI(f.app, { terminal });
  t.after(() => ui.stop());
  ui.start(); ui.editor.setText('PROMPT-AT-BOTTOM');
  for (const [columns, rows] of [[100,32],[68,24],[40,18],[28,12],[100,32]]) {
    terminal.resize(columns,rows);
    const lines = frame(ui);
    assert.equal(lines.length, rows);
    assert.match(lines[rows-5], /PROMPT-AT-BOTTOM/);
    assert.match(lines[rows-3], /test/);
    assert.doesNotMatch(lines[rows-1], /\$|ready|working|commands|ctrl|requests|cost/);
    assert.ok(ui.tui.getScreenLines().every(line => visibleWidth(line) <= columns));
  }
  for (let i = 0; i < 30; i++) ui.note(`TRANSCRIPT-${i}`);
  let lines = frame(ui); assert.match(lines[27], /PROMPT-AT-BOTTOM/); assert.ok(lines.some(l => l.includes('TRANSCRIPT-29')));
  const choice = ui.choose('Select an account', Array.from({length:20},(_,i)=>({value:String(i),label:`Account ${i}`})));
  lines = frame(ui); assert.match(lines[27], /PROMPT-AT-BOTTOM/);
  terminal.input('\x1b'); await choice;
});

test('footer hides provider, right-aligns thinking, and shows the active account usage without cost', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const ui = new TerminalUI(f.app); t.after(() => clearTimeout(ui.renderTimer));
  f.session.totals.cost = 987.65; f.app.engine.busy = true;
  f.app.activeAccount = { id: 'a', name: 'Personal' }; f.app.activeUsage = { totalTokens: 1250, requests: 2 };
  const lines = ui.footer.render(100).map(stripTerminalSequences);
  assert.ok(lines[0].startsWith('  test')); assert.ok(lines[0].endsWith('off'));
  assert.equal(visibleWidth(lines[0]),99); assert.doesNotMatch(lines.join('\n'), /fixture|987|thinking/);
  assert.match(lines[1], /Personal.*session.*1.3k tokens/);
  assert.match(lines[1], /session/);
  f.app.engine.busy = false;
});

test('SGR mouse click starts the 3D logo, Escape restores the draft and all animation timers stop', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const terminal = new MemoryTerminal(100,32), ui = new TerminalUI(f.app,{terminal});
  t.after(() => ui.stop()); ui.start(); ui.editor.setText('preserve my draft'); frame(ui);
  assert.equal(ui.logoTimer, undefined);
  terminal.input('\x1b[<0;10;5M'); terminal.input('\x1b[<0;10;5m');
  assert.ok(ui.logoAnimation); assert.ok(ui.logoTimer); assert.ok(ui.tui.hasOverlay());
  assert.ok(frame(ui).some(l => l.includes('click or esc to return')));
  terminal.input('\x1b');
  assert.equal(ui.logoAnimation,null); assert.equal(ui.logoTimer,null); assert.equal(ui.tui.hasOverlay(),false);
  assert.equal(ui.editor.getText(),'preserve my draft');
  assert.match(frame(ui)[27], /preserve my draft/);
  ui.showLogo(); ui.stop(); assert.equal(ui.logoTimer,null);
});

test('the extruded Psi mesh changes with 3D rotation and fits its terminal canvas', () => {
  const a=renderPsi(52,20,0,true), b=renderPsi(52,20,1.2,true);
  assert.equal(a.length,20); assert.notDeepEqual(a,b);
  assert.ok(a.every(line=>visibleWidth(line)===52));
  assert.ok(a.join('').includes('48;2;'));
});

test('the composer mode chip preserves full draft width and switches silently with a mouse click',async t=>{
  const f=await fixture(t,()=>({text:'Unused'})),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();ui.editor.setText('Keep this draft\nand this second line');
  let lines=frame(ui);assert.ok(lines.some(l=>/EXECUTE/.test(l)));assert.ok(lines.some(l=>/^ Keep this draft/.test(l)));assert.doesNotMatch(lines.at(-1),/EXECUTE|PLAN/);
  const row=lines.findIndex(l=>l.includes('EXECUTE'))+1,col=ui.editor.modeBounds.x+2;
  const count=ui.transcript.children.length;terminal.input(`\x1b[<0;${col};${row}M`);terminal.input(`\x1b[<0;${col};${row}m`);await ui.modeSwitch;
  lines=frame(ui);assert.equal(f.app.engine.config.agentMode,'plan');assert.equal(ui.editor.getText(),'Keep this draft\nand this second line');assert.ok(lines.some(l=>/PLAN/.test(l)));assert.ok(lines.some(l=>/^ Keep this draft/.test(l)));assert.equal(ui.transcript.children.length,count);
  for(const columns of [28,40,68,100]){terminal.resize(columns,32);frame(ui);assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=columns));}
});

test('message motion changes only presentation, keeps complete streamed content and stops when work ends',async t=>{
  const f=await fixture(t,()=>({text:'Unused'})),terminal=new MemoryTerminal(100,32);let now=0;const ui=new TerminalUI(f.app,{terminal,now:()=>now});f.app.ui=ui;t.after(()=>ui.stop());ui.start();
  ui.user('Send this complete message');frame(ui);const sent=ui.tui.getScreenLines();assert.ok(ui.motionTimer);now=160;const settled=frame(ui);assert.notDeepEqual(sent,ui.tui.getScreenLines());assert.match(settled.join('\n'),/Send this complete message/);
  ui.event({type:'request_start'});const initial=ui.response.render(80);now=640;assert.notDeepEqual(initial,ui.response.render(80));
  ui.event({type:'text_delta',delta:'A complete **answer**, with '});ui.event({type:'text_delta',delta:'all incoming text visible immediately.'});assert.equal(ui.response.text,'A complete **answer**, with all incoming text visible immediately.');
  const component=ui.response;ui.event({type:'request_end'});ui.event({type:'run_end',status:'idle'});assert.equal(ui.motionTimer,null);assert.equal(component.active,false);assert.doesNotMatch(component.render(80).join('\n'),/responding|thinking/);assert.match(frame(ui).join('\n'),/all incoming text visible immediately/);
  ui.event({type:'request_start'});assert.ok(ui.motionTimer);ui.event({type:'waiting',reason:'Waiting for quota'});assert.equal(ui.motionTimer,null);assert.equal(ui.response,null);
  ui.event({type:'request_start'});assert.ok(ui.motionTimer);ui.stop();assert.equal(ui.motionTimer,null);
});

test('reduced motion keeps response and tool state visible without animation timers or empty reply remnants',async t=>{
  const f=await fixture(t,()=>({text:'Unused'})),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();f.app.engine.config.animations=false;
  ui.user('A static send');ui.event({type:'request_start'});assert.ok(!ui.motionTimer);assert.match(frame(ui).join('\n'),/Psi.*thinking/);
  ui.event({type:'request_end'});assert.equal(ui.transcript.children.length,1);
  const call={id:'read-1',name:'read',arguments:{path:'src/main.cpp'}};ui.event({type:'tool_start',call});assert.match(frame(ui).join('\n'),/read.*src\/main.cpp.*running/);assert.ok(!ui.motionTimer);
  ui.event({type:'tool_end',call,duration:200,result:{isError:false,content:[{type:'text',text:'Verified source'}]}});assert.equal(ui.transcript.children.length,2);assert.match(frame(ui).join('\n'),/read.*done.*0.2s/);assert.match(frame(ui).join('\n'),/Verified source/);
  const background={id:'shell-1',name:'bash',arguments:{command:'run a long benchmark'}};ui.event({type:'tool_start',call:background});ui.event({type:'tool_end',call:background,duration:100,result:{isError:false,content:[{type:'text',text:JSON.stringify({id:'durable-job-1',status:'running',output:'Benchmark started'})}]}});assert.match(frame(ui).join('\n'),/job durable-job-1.*running/);
  f.session.state.progress={percent:60};const progress=stripTerminalSequences(ui.progressBar.render(100)[0]);assert.match(progress,/█+░+/);assert.match(progress,/60%.*40% remaining/);
});
