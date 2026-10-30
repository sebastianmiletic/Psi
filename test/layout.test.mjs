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
    assert.match(lines[rows-4], /PROMPT-AT-BOTTOM/);
    assert.match(lines[rows-2], /test/);
    assert.doesNotMatch(lines[rows-1], /\$|ready|working|commands|ctrl|requests|cost/);
    assert.ok(ui.tui.getScreenLines().every(line => visibleWidth(line) <= columns));
  }
  for (let i = 0; i < 30; i++) ui.note(`TRANSCRIPT-${i}`);
  let lines = frame(ui); assert.match(lines[28], /PROMPT-AT-BOTTOM/); assert.ok(lines.some(l => l.includes('TRANSCRIPT-29')));
  const choice = ui.choose('Select an account', Array.from({length:20},(_,i)=>({value:String(i),label:`Account ${i}`})));
  lines = frame(ui); assert.match(lines[28], /PROMPT-AT-BOTTOM/);
  terminal.input('\x1b'); await choice;
});

test('footer hides provider, right-aligns thinking, and shows the active account usage without cost', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const ui = new TerminalUI(f.app); t.after(() => clearTimeout(ui.renderTimer));
  f.session.totals.cost = 987.65; f.app.engine.busy = true;
  f.app.activeAccount = { id: 'a', name: 'Personal' }; f.app.activeUsage = { totalTokens: 1250, requests: 2 };
  const lines = ui.footer.render(100).map(stripTerminalSequences);
  assert.ok(lines[0].startsWith('  test')); assert.ok(lines[0].endsWith('thinking off'));
  assert.equal(visibleWidth(lines[0]),99); assert.doesNotMatch(lines.join('\n'), /fixture|\$|987/);
  assert.match(lines[1], /Personal.*1.3k tokens.*2 calls in Psi/);
  assert.match(lines[1], /quota unavailable/);
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
  assert.match(frame(ui)[28], /preserve my draft/);
  ui.showLogo(); ui.stop(); assert.equal(ui.logoTimer,null);
});

test('the extruded Psi mesh changes with 3D rotation and fits its terminal canvas', () => {
  const a=renderPsi(52,20,0,true), b=renderPsi(52,20,1.2,true);
  assert.equal(a.length,20); assert.notDeepEqual(a,b);
  assert.ok(a.every(line=>visibleWidth(line)===52));
  assert.ok(a.join('').includes('48;2;'));
});
