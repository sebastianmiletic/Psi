import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences,visibleWidth } from '@earendil-works/pi-tui';
import { TerminalUI } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { fixture } from './helpers.mjs';
import { applicableQuota } from '../src/usage.mjs';
import { accentColor } from '../src/theme.mjs';
const frame=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
async function setup(t){const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32);let now=0;const ui=new TerminalUI(f.app,{terminal,now:()=>now});f.app.ui=ui;t.after(()=>ui.stop());ui.start();return{...f,terminal,ui,time:n=>now=n};}

test('effort uses a dedicated staged slider and Escape cancels without stopping the active run',async t=>{
 const f=await setup(t),{ui,terminal}=f;let stopped=0;f.app.engine.busy=true;const stop=f.app.engine.stop.bind(f.app.engine);f.app.engine.stop=()=>{stopped++;stop();};
 let menu=ui.effortMenu({levels:['low','medium','high'],effort:'medium',overkill:false});assert.doesNotMatch(frame(ui).join('\n'),/Search:/);assert.match(frame(ui).join('\n'),/OVERKILL/);
 terminal.input('\x1b[C');terminal.input('\t');assert.deepEqual(ui.effortPreview,{effort:'high',overkill:true});assert.equal(f.app.engine.config.overkill,false);terminal.input('\x1b');assert.equal(await menu,null);assert.equal(stopped,0);assert.equal(ui.pending,null);assert.equal(ui.effortPreview,null);assert.ok(!ui.motionTimer);
 menu=ui.effortMenu({levels:['low','medium','high'],effort:'medium',overkill:false});terminal.input('\x1b[C');terminal.input('\t');terminal.input('\r');assert.deepEqual(await menu,{effort:'high',overkill:true});
 terminal.resize(28,18);menu=ui.effortMenu({levels:['off','minimal','low','medium','high','xhigh'],effort:'medium',overkill:false});const small=frame(ui).join('\n');assert.match(small,/medium/);assert.match(small,/apply · esc cancel/);terminal.input('\x1b');await menu;f.app.engine.busy=false;
});
test('OVERKILL flows in the chosen accent without moving slash commands, and respects disabled animation',async t=>{
 const f=await setup(t),{ui}=f;f.app.engine.config.accent='rose';f.app.engine.config.overkill=true;ui.syncMotion();ui.editor.setText('/model');let lines=frame(ui);const before=ui.tui.getScreenLines();assert.equal(lines.find(l=>l.includes('/model')).indexOf('/model'),1);assert.ok(ui.motionTimer);
 f.time(520);frame(ui);assert.notDeepEqual(before,ui.tui.getScreenLines());assert.equal(ui.editor.getText(),'/model');
 f.app.engine.config.animations=false;ui.syncMotion();frame(ui);const stable=ui.tui.getScreenLines();f.time(1000);frame(ui);assert.deepEqual(stable,ui.tui.getScreenLines());assert.equal(ui.motionTimer,null);
 await f.app.setMode('plan');assert.equal(ui.transcript.children.length,0);lines=frame(ui);assert.equal(lines.find(l=>l.includes('/model')).indexOf('/model'),1);
});
test('the blue quota bar prefers five hours, falls back to weekly, and never invents unavailable quotas',async t=>{
 const f=await setup(t),{ui}=f;f.app.engine.config.accent='rose';f.app.activeAccount={name:'Personal',type:'oauth',billingMode:'subscription'};
 f.app.activeUsage={limitsAt:new Date().toISOString(),limits:[{kind:'quota',label:'7d',usedPercent:40,resetAt:9999999999},{kind:'quota',label:'5h',usedPercent:25,resetAt:9999999999}]};
 let bar=ui.progressBar.render(100)[0];const c=accentColor({accent:'blue'});assert.ok(bar.includes(`\x1b[38;2;${c.r};${c.g};${c.b}m`));assert.match(stripTerminalSequences(bar),/5h limit.*25% used/);assert.match(stripTerminalSequences(ui.footer.render(100)[1]),/7d 40% used/);assert.doesNotMatch(stripTerminalSequences(ui.footer.render(100)[1]),/5h/);
 f.app.activeUsage.limits[1].resetAt=1;assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/7d limit.*40% used/);f.app.activeUsage.limits=[];assert.match(stripTerminalSequences(ui.progressBar.render(100)[0]),/Goal/);assert.equal(applicableQuota(null),null);
});
test('stats opens a tabbed UI, preserves the draft and closes with one Escape without chat output',async t=>{
 const f=await setup(t),{ui,terminal}=f;ui.editor.setText('/model');const count=ui.transcript.children.length,menu=f.app.submit('/stats');await delay(60);let lines=frame(ui);assert.match(lines.join('\n'),/Your Psi activity/);assert.match(lines.join('\n'),/Tokens/);assert.match(lines.join('\n'),/Active time/);assert.ok(ui.tui.hasOverlay());terminal.input('\t');assert.match(frame(ui).join('\n'),/\[ This week \]/);
 for(const [columns,rows]of[[68,24],[28,18],[100,32]]){terminal.resize(columns,rows);const screen=frame(ui);assert.match(screen.join('\n'),columns>=80?/\[ This week \]/:/\[ Week \]/);assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=columns));}
 terminal.input('\x1b');await menu;assert.equal(ui.pending,null);assert.equal(ui.tui.hasOverlay(),false);assert.equal(ui.editor.getText(),'/model');assert.equal(ui.transcript.children.length,count);assert.equal(f.requests.length,0);
});
test('queued mode and effort changes remain out of the conversation',async t=>{
 const f=await setup(t);f.app.engine.busy=true;await f.app.engine.settings({agentMode:'plan'});await f.app.engine.settings({effort:'off',overkill:true});assert.equal(f.ui.transcript.children.length,0);assert.equal(f.session.messages.length,0);f.app.engine.busy=false;
});
