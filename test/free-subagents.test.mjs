import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { fixture } from './helpers.mjs';
import { TerminalUI } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { settingItems } from '../src/settings.mjs';
import { runtimeContext } from '../src/prompt.mjs';
import { workerDisplay } from '../src/subagents-ui.mjs';
import { Session } from '../src/session.mjs';

async function workers(t, count = 40) {
  const f = await fixture(t, () => ({ text: 'unused' }));
  await f.session.message({ role: 'user', content: 'Build a project with independent assignments', timestamp: Date.now() });
  await f.app.update({ overkill: true, subagentConcurrency: 1, agents: [{ id: 'retired', mode: 'plan' }] });
  const jobs = new Map();
  f.app.jobs.start = async () => { const j = { id: 'captured-' + jobs.size, status: 'running' }; jobs.set(j.id, j); return j; };
  f.app.jobs.get = async id => { if (!jobs.has(id)) throw new Error('Unknown captured job'); return jobs.get(id); };
  f.app.jobs.stop = async id => { const job = await f.app.jobs.get(id); job.status = 'cancelled'; return job; };
  f.app.jobs.awaitCompletion = async id => f.app.jobs.get(id);
  f.app.agents.track = () => {};
  const records = [];
  for (let i = 0; i < count; i++) records.push(await f.app.agents.spawn({ name: 'Inspect fixture ' + i, prompt: 'Inspect independent fixture ' + i, group: i < 16 ? 'Navigation' : i < 32 ? 'Benchmarks' : 'Documentation' }));
  return { ...f, jobs, records };
}

test('more than 32 active assignments survive save and restore without profiles or a worker-count cap', async t => {
  const f = await workers(t);
  assert.equal(f.records.length, 40);
  assert.equal(f.app.engine.config.subagentConcurrency, undefined);
  assert.equal(f.app.engine.config.agents, undefined);
  for (const record of f.records) {
    assert.equal(record.model, 'fixture/test');
    const manifest = JSON.parse(await readFile(join(f.session.dir, 'agents', record.sessionId, 'worker.json')));
    assert.equal(manifest.config.agents, undefined);
    assert.equal(manifest.config.maxSteps, 0);
    assert.equal(manifest.config.subagentConcurrency, undefined);
    assert.equal(manifest.config.subagentDepth, 1);
  }
  const restored = await Session.load(f.session.meta.id, f.app.home);
  assert.equal(restored.state.agents.length, 40);
  assert.equal((await Session.list(f.app.home)).length, 1);
  const terminal = new MemoryTerminal(100, 32), ui = new TerminalUI(f.app, { terminal }); f.app.ui = ui; t.after(() => ui.stop()); ui.start();
  await f.app.agents.restore();
  assert.equal(ui.workerRows.size, 40);
  assert.ok(ui.workerRows.has(f.records[0].id));
  assert.deepEqual(workerDisplay([...ui.workerRows.values()]).map(g => [g.name, g.workers.length]), [['Navigation', 16], ['Benchmarks', 16], ['Documentation', 8]]);
  for (const columns of [28, 50, 100]) {
    terminal.resize(columns, 32); ui.tui.renderNow();
    assert.ok(ui.tui.getScreenLines().every(line => visibleWidth(line) <= columns));
    const frame = ui.tui.getScreenLines().map(stripTerminalSequences).join('\n');
    assert.match(frame, /Navigation/); assert.match(frame, /Benchmarks/); assert.match(frame, /Documentation/);
  }
  f.jobs.get(f.records[0].jobId).status = 'completed';
  await f.app.agents.send(f.records[0].id, 'Inspect another independent fixture');
  assert.equal(f.jobs.size, 41);
  assert.equal((await f.app.agents.get(f.records[0].id)).group, 'Navigation');
  for (const record of f.records) ui.event({ type: 'agent_finished', agent: { ...record, status: 'completed' } });
  assert.equal(ui.workerRows.size, 0);
  assert.equal((await f.app.agents.records()).length, 40);
  assert.equal(f.requests.length, 0);
});

test('grouped menus expose each assignment while retired controls and tool profile fields are absent', async t => {
  const f = await workers(t, 5); const menus = []; let actions = ['group:0', 'run:' + f.records[0].id, null, null];
  f.app.ui = { stop() {}, choose: async (title, items) => { menus.push({ title, items }); return actions.shift(); } };
  await f.app.agentsMenu();
  const menu = menus[0];
  assert.ok(menu.items.some(i => i.label === 'Navigation' && i.description === '5 active'));
  assert.ok(menus[1].items.some(i => i.value === 'run:' + f.records[0].id));
  assert.ok(!menu.items.some(i => /profile:|concurrency|add/.test(i.value)));
  const schema = f.app.tools.definitions().find(d => d.name === 'agent').parameters.properties;
  assert.equal(schema.profile, undefined); assert.ok(schema.group); assert.ok(schema.model); assert.ok(schema.effort);
  assert.ok(!settingItems.some(i => ['agents', 'subagentConcurrency'].includes(i.id)));
  assert.doesNotMatch(runtimeContext(f.session,f.app.engine.config), /"presets"|"maxWorkers"|subagentConcurrency/);
});

test('group labels are validated before any child is created and overflow counts every active worker', async t => {
  const f = await workers(t, 1), before = await readdir(join(f.session.dir, 'agents'));
  for (const group of ['', 'one two three four five six']) await assert.rejects(f.app.agents.spawn({ name: 'Check new fixture', prompt: 'Different task', group }), /group name/);
  await assert.rejects(f.app.agents.spawn({ name: 'Check new fixture', prompt: 'Different task', model: 'missing/model' }), /Model not found/);
  assert.deepEqual(await readdir(join(f.session.dir, 'agents')), before);
  const input = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: 'Task ' + i, group: 'Group ' + (i % 5), status: 'running' }));
  const rows = workerDisplay(input, 3);
  assert.equal(rows.reduce((sum, g) => sum + g.workers.length + g.hidden, 0), 50);
  assert.equal(rows.at(-1).hidden, 20);
  assert.deepEqual(workerDisplay(input.map(r => ({ ...r, status: 'completed' }))), []);
});

const screen=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
function click(terminal,lines,text){const row=lines.findIndex(line=>line.includes(text));assert.ok(row>=0,'Visible click target: '+text);terminal.input(`\x1b[<0;4;${row+1}M`);terminal.input(`\x1b[<0;4;${row+1}m`);}
async function footerFixture(t,count=8){
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,36),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());f.app.engine.config.animations=false;ui.start();ui.editor.setText('Keep this draft');
 for(let i=0;i<count;i++)ui.event({type:'agent_status',agent:{id:'group-worker-'+i,name:'Assignment '+i,group:i<count/2?'Navigation':'Benchmarks',status:i%3?'running':'waiting',activity:'read',model:'fixture/test',createdAt:new Date().toISOString()}});
 return{...f,terminal,ui};
}
test('clicking a group expands individual workers below usage and raises the composer; click again collapses',async t=>{
 const {ui,terminal,requests}=await footerFixture(t);const before=screen(ui),inputRow=before.findIndex(line=>line.includes('EXECUTE')),history=ui.transcript.children.length;
 assert.match(before.join('\n'),/▸ Navigation/);click(terminal,before,'Navigation');let lines=screen(ui);
 assert.ok(lines.findIndex(line=>line.includes('EXECUTE'))<inputRow);assert.match(lines.join('\n'),/▾ Navigation/);
 for(let i=0;i<4;i++)assert.match(lines.join('\n'),new RegExp('Assignment '+i+' · read · test'));
 const usage=lines.findIndex(line=>line.includes('% left'));assert.ok(lines.findIndex(line=>line.includes('▾ Navigation'))>usage);assert.match(lines.slice(0,6).join('\n'),/Ψ\s+v/);
 terminal.input('!');assert.equal(ui.editor.getText(),'Keep this draft!');terminal.input('\x7f');
 click(terminal,lines,'▾ Navigation');lines=screen(ui);assert.equal(lines.findIndex(line=>line.includes('EXECUTE')),inputRow);assert.equal(ui.editor.getText(),'Keep this draft');assert.equal(ui.transcript.children.length,history);assert.equal(requests.length,0);
});
test('large expanded groups scroll to every worker with a pinned collapse control and survive resizes',async t=>{
 const {ui,terminal,requests}=await footerFixture(t,60);let lines=screen(ui);click(terminal,lines,'Navigation');lines=screen(ui);
 assert.match(lines.join('\n'),/▾ Subagents · collapse/);assert.ok(ui.subagentBar.scroll.viewportHeight>0);assert.match(lines.join('\n'),/Keep this draft/);
 const seen=new Set();for(let i=0;i<30;i++){
  for(const line of lines){const m=line.match(/Assignment (\d+) · read/);if(m)seen.add(Number(m[1]));}
  const row=lines.findIndex(line=>line.includes('▾ Navigation'));
  const wheelRow=row>=0?row+2:terminal.rows-2;
  terminal.input(`\x1b[<65;6;${wheelRow}M`);lines=screen(ui);
 }
 for(let i=0;i<30;i++)assert.ok(seen.has(i),'Scrollable worker '+i);
 for(const [columns,rows]of[[28,18],[68,24],[100,36]]){terminal.resize(columns,rows);lines=screen(ui);assert.match(lines.join('\n'),/Subagents/);assert.match(lines.join('\n'),/EXEC/);assert.match(lines.slice(0,6).join('\n'),/Ψ\s+v/);assert.ok(lines.every(line=>visibleWidth(line)<=columns));}
 click(terminal,lines,'Subagents');lines=screen(ui);assert.equal(ui.subagentBar.expanded.size,0);assert.match(lines.join('\n'),/▸ Navigation/);assert.equal(ui.editor.getText(),'Keep this draft');assert.equal(requests.length,0);
});
test('overflow and keyboard toggle expose all groups; completed workers disappear and switching chats resets expansion',async t=>{
 const {ui,terminal}=await footerFixture(t,12);
 for(const [i,worker]of [...ui.workerRows.values()].entries())ui.workerRows.set(worker.id,{...worker,group:'Group '+i});
 let lines=screen(ui);click(terminal,lines,'more');lines=screen(ui);assert.equal(ui.subagentBar.expanded.size,12);assert.match(lines.join('\n'),/Subagents/);
 terminal.input('\x07');screen(ui);assert.equal(ui.subagentBar.expanded.size,0);terminal.input('\x07');screen(ui);assert.equal(ui.subagentBar.expanded.size,12);
 for(const worker of [...ui.workerRows.values()])ui.event({type:'agent_finished',agent:{...worker,status:'completed'}});
 lines=screen(ui);assert.equal(ui.workerRows.size,0);assert.equal(ui.subagentBar.expanded.size,0);assert.doesNotMatch(lines.join('\n'),/Subagents · collapse/);
 ui.workerRows.set('new',{id:'new',name:'Next assignment',group:'Next group',status:'running'});terminal.input('\x07');screen(ui);assert.equal(ui.subagentBar.expanded.size,1);ui.clear();screen(ui);assert.equal(ui.subagentBar.expanded.size,0);
});

 test('groups expand independently and keep live membership while a menu is open',async t=>{
 const {ui,terminal}=await footerFixture(t);let lines=screen(ui);click(terminal,lines,'Navigation');lines=screen(ui);click(terminal,lines,'Benchmarks');lines=screen(ui);assert.equal(ui.subagentBar.expanded.size,2);
 const menu=ui.effortMenu({levels:['low','medium','high'],effort:'medium',overkill:false});lines=screen(ui);assert.match(lines.join('\n'),/OVERKILL/);assert.match(lines.join('\n'),/EXECUTE/);assert.match(lines.slice(0,6).join('\n'),/Ψ\s+v/);terminal.input('\x1b');await menu;
 for(const worker of [...ui.workerRows.values()].slice(0,6))ui.event({type:'agent_status',agent:{...worker,status:'completed'}});
 lines=screen(ui);assert.match(lines.join('\n'),/▾ Benchmarks/);assert.match(lines.join('\n'),/Assignment 6 · read/);assert.doesNotMatch(lines.join('\n'),/Navigation/);assert.equal(ui.subagentBar.expanded.size,1);
 click(terminal,lines,'▾ Benchmarks');assert.equal(ui.subagentBar.expanded.size,0);assert.equal(ui.editor.getText(),'Keep this draft');
});
