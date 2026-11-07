import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {fixture} from './helpers.mjs';
import {MemoryTerminal} from './terminal.mjs';
import {Session} from '../src/session.mjs';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
async function until(check){const deadline=Date.now()+8000;while(Date.now()<deadline){if(check())return;await delay(10);}assert.fail('UI did not become ready');}

test('accounts, models, stats and settings open while a real model request is in flight; switching preserves the pinned request',async t=>{
 let ready,release;const arrived=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,async(_p,n)=>{if(n===1){ready();await gate;return{call:{name:'write',args:{path:'preserved.txt',content:'done'}}};}return{text:'Finished on the new account.'};});
 f.app.registry.register({...f.config.customProviders[0],keyless:false});const first=await f.app.registry.accounts.add('fixture','Current',{type:'api_key',key:'first'}),second=await f.app.registry.accounts.add('fixture','Backup',{type:'api_key',key:'second'});await f.app.registry.accounts.use(first);
 f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false});await f.app.startUI();const {ui}=f.app,terminal=ui.terminal,run=f.app.submit('Keep working during menus');await arrived;
 try{
  ui.editor.setText('Keep my draft');let menu=f.app.submit('/accounts');await until(()=>!!ui.composerSearch);assert.match(frame(ui).join('\n'),/Accounts/);terminal.input('\x1b');await menu;
  menu=f.app.submit('/model');await until(()=>!!ui.composerSearch);terminal.input('test');assert.match(frame(ui).join('\n'),/Model/);terminal.input('\x1b');await menu;
  menu=f.app.submit('/settings');await until(()=>!!ui.pending);assert.match(frame(ui).join('\n'),/Settings/);terminal.input('\x1b');await menu;
  menu=f.app.submit('/stats');await until(()=>frame(ui).some(line=>line.includes('AI Time')));let lines=frame(ui);assert.match(lines.join('\n'),/\[Session\]/);assert.match(lines.join('\n'),/Human/);assert.match(lines.join('\n'),/Tokens/);
  for(const [columns,rows]of [[28,18],[68,24],[100,32]]){terminal.resize(columns,rows);lines=frame(ui);assert.match(lines.join('\n'),/Human/);assert.match(lines.slice(0,6).join('\n'),/Ψ\s+v/);assert.ok(lines.every(line=>visibleWidth(line)<=columns));}
  terminal.input('\x1b');await menu;
  menu=f.app.submit('/accounts switch');await until(()=>!!ui.composerSearch);terminal.input('Backup');terminal.input('\r');await menu;
  assert.equal((await f.app.registry.accounts.selected('fixture')).id,second);assert.equal(f.app.engine.busy,true);assert.equal(f.app.engine.controller.signal.aborted,false);assert.equal(f.requests.length,1);assert.equal(ui.editor.getText(),'Keep my draft');assert.ok(!f.events.some(e=>e.type==='stopped'));
 }finally{release();await run;}
 assert.deepEqual(f.requestHeaders.map(h=>h.authorization),['Bearer first','Bearer second']);assert.equal(f.session.status,'idle');
});

test('human activity journals timestamps only, throttles input and seals an interval at session switch and close',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false});await f.app.startUI();
 const ui=f.app.ui;ui.terminal.input('PRIVATE KEYSTROKES');ui.terminal.input('MORE PRIVATE');await f.session.flush();let events=[];for await(const e of f.session.events())if(e.type==='ui_activity')events.push(e);assert.equal(events.length,1);assert.equal(events[0].kind,'focus');assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
 ui.terminal.input('\x1b[O');ui.terminal.input('x');await f.session.flush();events=[];for await(const e of f.session.events())if(e.type==='ui_activity')events.push(e);assert.deepEqual(events.map(e=>e.kind),['focus','blur','input']);
 await f.session.rename('Preserve activity fixture');const original=f.session;await f.app.changeSession(await Session.create(f.root,f.app.home));await original.flush();events=[];for await(const e of original.events())if(e.type==='ui_activity')events.push(e);assert.equal(events.at(-1).kind,'closed');
 const current=f.app.session;await current.rename('Second activity fixture');await f.app.close();events=[];for await(const e of current.events())if(e.type==='ui_activity')events.push(e);assert.deepEqual(events.map(e=>e.kind),['focus','closed']);
});

test('session stats refresh automatically and closing the panel stops its refresh timer',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const f=await fixture(t,()=>({text:'unused'}));f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:false,animations:false});await f.app.startUI();
 let refreshes=0;const read=f.app.statistics.read.bind(f.app.statistics),menu=f.app.ui.statsMenu(async()=>{refreshes++;return read({sessionId:f.session.meta.id});});await until(()=>frame(f.app.ui).some(line=>line.includes('AI Time')));assert.equal(refreshes,1);
 t.mock.timers.tick(5000);await until(()=>refreshes===2);f.app.ui.terminal.input('\x1b');await menu;t.mock.timers.tick(10000);await delay(0);assert.equal(refreshes,2);assert.equal(f.app.ui.pending,null);assert.equal(f.requests.length,0);
});
