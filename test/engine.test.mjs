import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../src/session.mjs';
import { splitForCompaction, LimitError } from '../src/engine.mjs';
import { fixture } from './helpers.mjs';

test('HTTP streaming model executes write, detached benchmark, fetch and finish; resume preserves evidence and cost', async t => {
  const f = await fixture(t, (_payload, n, port) => {
    if (n === 1) return { call: { name: 'write', args: { path: 'candidate.txt', content: 'frozen-baseline' } } };
    if (n === 2) return { call: { name: 'bash', args: { command: "printf 'benchmark-ok\\n'", label: 'fixture benchmark', yield_ms: 2000 } } };
    if (n === 3) return { call: { name: 'fetch', args: { url: `http://127.0.0.1:${port}/page` } } };
    if (n === 4) return { call: { name: 'finish', args: { summary: 'Verified fixture workflow.', evidence: ['candidate.txt'] } } };
    return { text: 'Fixture completed with recorded evidence.' };
  });
  await f.app.engine.run('Run the isolated test workflow.', { loop: true });
  assert.equal(await readFile(join(f.root, 'candidate.txt'), 'utf8'), 'frozen-baseline');
  assert.equal(f.session.status, 'idle');
  assert.equal(f.requests.length, 4);
  assert.equal(f.session.totals.requests, 4);
  assert.ok(f.session.totals.cost > 0);
  const toolResults = f.session.messages.filter(m => m.role === 'toolResult');
  assert.equal(toolResults.length, 4);
  assert.ok(toolResults.every(m => !m.isError));
  assert.match(toolResults[1].content[0].text, /benchmark-ok/);
  assert.match(toolResults[2].content[0].text, /18 wins/);
  assert.doesNotMatch(toolResults[2].content[0].text, /untrusted\(\)/);
  assert.equal(f.session.state.loopGoal, null);
  const restored = await Session.load(f.session.meta.id, f.session.home);
  assert.deepEqual(restored.messages, f.session.messages);
  assert.deepEqual(restored.totals, f.session.totals);
  assert.equal(f.requests[1].messages.at(-1).role, 'tool');
});

test('budget blocks a request before network activity', async t => {
  const f = await fixture(t, () => ({ text: 'Should not be reached' }));
  f.app.engine.config.budget = 0.000001;
  await assert.rejects(f.app.engine.run('Do work'), LimitError);
  assert.equal(f.requests.length, 0); assert.equal(f.session.status, 'limited');
});

test('step ceiling pauses a loop with a durable pending goal', async t => {
  const f = await fixture(t, () => ({ call: { name: 'checkpoint', args: { note: 'Experiment A complete; next experiment B.' } } }));
  f.app.engine.config.maxSteps = 1;
  await assert.rejects(f.app.engine.run('Two experiments', { loop: true }), /request limit/);
  assert.equal(f.requests.length, 1); assert.equal(f.session.state.loopGoal, 'Two experiments');
  assert.match(await readFile(join(f.session.dir, 'checkpoint.md'), 'utf8'), /experiment B/);
  const restored = await Session.load(f.session.meta.id, f.session.home);
  assert.equal(restored.messages.filter(m => m.role === 'toolResult').length, 1);
});

test('transient HTTP failure retries; authentication failure does not', async t => {
  const f = await fixture(t, (_payload, n) => n === 1 ? { httpError: 503 } : { text: 'Recovered.' });
  await f.app.engine.run('Check retry');
  assert.equal(f.requests.length, 2); assert.equal(f.events.filter(e => e.type === 'retry').length, 1);
  const g = await fixture(t, () => ({ httpError: 401, message: 'Invalid API key' }));
  await assert.rejects(g.app.engine.run('Check auth'), /Invalid API key|401/);
  assert.equal(g.requests.length, 1);
});

test('compaction preserves recent tool pairs and full journal', async t => {
  const f = await fixture(t, () => ({ text: 'Summary: baseline A, pending experiment B, evidence stored in results.json.' }));
  for (let i = 0; i < 6; i++) {
    await f.session.message({ role: 'user', content: `Task ${i}`, timestamp: Date.now() });
    await f.session.message({ role: 'assistant', content: [{ type: 'text', text: `Result ${i}` }], api: 'openai-completions', provider: 'fixture', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  }
  await f.app.engine.run(null, { compactOnly: true });
  assert.ok(f.session.messages.length < 12);
  assert.match(f.session.messages[0].content, /baseline A/);
  const journal = await readFile(join(f.session.dir, 'events.jsonl'), 'utf8');
  assert.match(journal, /Task 0/); assert.match(journal, /"type":"compact"/);
  const [old, recent] = splitForCompaction([{ role: 'user' }, { role: 'assistant' }, { role: 'toolResult' }, { role: 'toolResult' }, { role: 'assistant' }], 2);
  assert.notEqual(recent[0]?.role, 'toolResult');
});

test('crash recovery records unknown tool outcome without re-executing it', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  await f.session.message({ role: 'assistant', content: [{ type: 'toolCall', id: 'crashed-call', name: 'write', arguments: { path: 'not-created.txt', content: 'x' } }], timestamp: Date.now() });
  const restored = await Session.load(f.session.meta.id, f.session.home);
  assert.equal(restored.messages.at(-1).toolCallId, 'crashed-call');
  assert.equal(restored.messages.at(-1).isError, true);
  await assert.rejects(readFile(join(f.root, 'not-created.txt')));
});
