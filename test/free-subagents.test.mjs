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
