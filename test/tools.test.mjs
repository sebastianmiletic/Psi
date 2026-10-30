import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/accounts.mjs';
import { Jobs } from '../src/jobs.mjs';
import { Registry } from '../src/providers.mjs';
import { defaults, readJSON, withLock } from '../src/storage.mjs';
import { fixture } from './helpers.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'psi-unit-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('named accounts refresh under a lock, switch independently by provider and never list secrets', async t => {
  const home = await temp(t); const accounts = new Accounts(home);
  const a = await accounts.add('anthropic', 'Personal', { type: 'api_key', key: 'secret-a' });
  const b = await accounts.add('anthropic', 'School', { type: 'api_key', key: 'secret-b' });
  const c = await accounts.add('openai-codex', 'Codex', { type: 'oauth', access: 'access-secret', refresh: 'refresh-secret', expires: 1, revision: 0 });
  assert.doesNotMatch(JSON.stringify(await accounts.list()), /secret/);
  await accounts.use(a); assert.equal((await accounts.store().read('anthropic')).key, 'secret-a');
  const store = accounts.store();
  await Promise.all(Array.from({ length: 5 }, () => store.modify('openai-codex', async old => ({ ...old, revision: old.revision + 1 }))));
  assert.equal((await store.read('openai-codex')).revision, 5);
  assert.equal((await stat(join(home, 'accounts.json'))).mode & 0o777, 0o600);
  await accounts.remove(a); assert.equal((await store.read('anthropic')).key, 'secret-b');
  assert.equal((await accounts.list()).find(x => x.id === c).active, true);
});

test('background jobs retain logs, return nonzero status and enforce timeouts', async t => {
  const home = await temp(t); const jobs = new Jobs(home, 'test');
  const good = await jobs.start("printf '24 games 18 wins\\n'", home);
  assert.equal((await jobs.wait(good.id, 5000)).status, 'completed');
  assert.match(await jobs.tail(good.id), /18 wins/);
  const bad = await jobs.start("printf 'failed\\n'; exit 7", home);
  const failure = await jobs.wait(bad.id, 5000); assert.equal(failure.status, 'failed'); assert.equal(failure.exitCode, 7);
  const timed = await jobs.start('sleep 20', home, { timeout_ms: 100 });
  assert.equal((await jobs.wait(timed.id, 5000)).status, 'timed_out');
});

test('background jobs can be stopped and log growth is bounded', async t => {
  const home = await temp(t); const jobs = new Jobs(home, 'test');
  const job = await jobs.start('sleep 30', home);
  await jobs.wait(job.id, 300);
  assert.equal((await jobs.stop(job.id)).status, 'cancelled');
  const capped = await jobs.start("python3 -c 'print(\"x\"*100000)'", home, { max_log_bytes: 1024 });
  const result = await jobs.wait(capped.id, 5000);
  assert.equal(result.logCapped, true); assert.ok((await stat(result.log)).size < 1200);
});

test('editing rejects ambiguity; replacement preserves literal dollar characters; oversized results have artifacts', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const call = (name, args) => f.app.tools.call({ id: `${name}-${Date.now()}`, name, arguments: args });
  await call('write', { path: 'text.txt', content: 'same same' });
  assert.equal((await call('edit', { path: 'text.txt', old: 'same', new: 'next' })).isError, true);
  await call('edit', { path: 'text.txt', old: 'same same', new: '$& literal' });
  assert.equal(await readFile(join(f.root, 'text.txt'), 'utf8'), '$& literal');
  f.app.tools.config.toolOutputChars = 100;
  await call('write', { path: 'large.txt', content: 'a'.repeat(3000) });
  const result = await call('read', { path: 'large.txt' });
  assert.match(result.content[0].text, /Full output:/);
  assert.equal((await call('read', { path: 'text.txt', offset: -1 })).isError, true);
});

test('catalog exposes >200 configured adapters and preserves native Codex/Claude OAuth', () => {
  const registry = new Registry(defaults);
  assert.ok(registry.models.getProviders().length >= 200);
  assert.ok(registry.models.getProvider('openai-codex').auth.oauth);
  assert.ok(registry.models.getProvider('anthropic').auth.oauth);
  assert.equal(registry.find(defaults.model).provider, 'openai-codex');
  assert.ok(registry.all().length > 1000);
});
