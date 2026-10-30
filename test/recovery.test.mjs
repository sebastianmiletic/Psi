import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../src/session.mjs';
import { withLock } from '../src/storage.mjs';
import { fixture } from './helpers.mjs';

test('torn journal append is removed before recovery and subsequent messages remain readable', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  await f.session.message({ role: 'user', content: 'Keep this', timestamp: 1 });
  await appendFile(join(f.session.dir, 'events.jsonl'), '{"type":"mess');
  const loaded = await Session.load(f.session.meta.id, f.session.home);
  await loaded.message({ role: 'user', content: 'After recovery', timestamp: 2 });
  const again = await Session.load(f.session.meta.id, f.session.home);
  assert.deepEqual(again.messages.map(m => m.content), ['Keep this', 'After recovery']);
});

test('an actively locked session cannot be loaded and repaired by another process', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  await withLock(join(f.session.dir, 'run.lock'), async () => {
    await assert.rejects(Session.load(f.session.meta.id, f.session.home), /Another Psi process/);
  });
});

test('stale in-memory session does not append over another writer', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const other = await Session.load(f.session.meta.id, f.session.home);
  await other.message({ role: 'user', content: 'New context', timestamp: 1 });
  const before = await readFile(join(f.session.dir, 'events.jsonl'), 'utf8');
  await assert.rejects(f.app.engine.run('Stale context'), /changed in another/);
  assert.equal(await readFile(join(f.session.dir, 'events.jsonl'), 'utf8'), before);
  assert.equal(f.requests.length, 0);
});

test('cancelling at a tool boundary records every call outcome and preserves resume', async t => {
  const f = await fixture(t, () => ({ call: { name: 'bash', args: { command: 'sleep 20', yield_ms: 60000 } } }));
  const original = f.app.options.onEvent;
  f.app.options.onEvent = e => { original(e); if (e.type === 'tool_start') setTimeout(() => f.app.engine.stop(), 150); };
  await f.app.engine.run('Start a long job');
  assert.equal(f.session.status, 'stopped');
  assert.equal(f.session.messages.at(-1).role, 'toolResult');
  assert.equal(f.session.messages.at(-1).isError, true);
  const jobs = await f.app.jobs.list();
  for (const job of jobs) await f.app.jobs.stop(job.id);
  const loaded = await Session.load(f.session.meta.id, f.session.home);
  assert.equal(loaded.messages.filter(m => m.role === 'toolResult').length, 1);
});

test('local Brave browser renders JavaScript and closes its process', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const call = (action, extra = {}) => f.app.tools.call({ id: action, name: 'browser', arguments: { action, ...extra } });
  const result = await call('open', { url: `http://127.0.0.1:${f.server.address().port}/page` });
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.match(result.content[0].text, /Published results/);
  const evaluated = await call('evaluate', { script: 'document.title + ":" + (7*6)' });
  assert.match(evaluated.content[0].text, /Fixture:42/);
  assert.equal((await call('close')).isError, false);
  assert.equal(f.app.tools.browser, null);
});
