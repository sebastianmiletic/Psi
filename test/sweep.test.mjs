import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from '../src/sweep.mjs';

test('paired sweep records frozen candidates, maps, seeds and both sides, then resumes without duplicate games', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'psi-sweep-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'baseline.wasm'), 'baseline'); await writeFile(join(cwd, 'candidate.wasm'), 'candidate');
  await writeFile(join(cwd, 'runner.mjs'), 'console.log(JSON.stringify({outcome:process.argv[2]==="baseline"?"loss":"win",seed:Number(process.argv[3]),side:Number(process.argv[4])}));');
  const manifest = { command: [process.execPath, 'runner.mjs', '{name}', '{seed}', '{side}'], candidates: [{ name: 'baseline', artifact: 'baseline.wasm' }, { name: 'candidate', artifact: 'candidate.wasm' }], seeds: [1, 2], sides: [0, 1], workers: 2, output: 'results', inputs: ['runner.mjs'], metadata: { engine: 'fixture' } };
  const result = await runSweep(manifest, { cwd });
  assert.equal(result.total, 8); assert.equal(result.candidates.baseline.losses, 4); assert.equal(result.candidates.candidate.wins, 4); assert.deepEqual(result.changedArtifacts, []);
  const rows = (await readFile(join(cwd, 'results/results.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(rows.map(r => r.key)).size, 8); assert.equal(rows[0].sha256.length, 64);
  assert.ok(rows.every(r => [0, 1].includes(r.side)));
  let launches = 0;
  await appendFile(join(cwd, 'results/results.jsonl'), '{"torn":');
  const resumed = await runSweep({ ...manifest, workers: 1 }, { cwd, onProgress: () => launches++ });
  assert.equal(launches, 0); assert.equal(resumed.total, 8);
  await writeFile(join(cwd, 'candidate.wasm'), 'changed');
  await assert.rejects(runSweep(manifest, { cwd }), /hashes changed/);
});

test('failed matches are recorded as errors and never as wins', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'psi-sweep-error-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'bot.wasm'), 'frozen');
  const manifest = { command: [process.execPath, '-e', 'console.log(JSON.stringify({outcome:"win"}));process.exit(5)'], candidates: [{ name: 'bot', artifact: 'bot.wasm' }], seeds: [1], output: 'results' };
  const result = await runSweep(manifest, { cwd });
  assert.equal(result.candidates.bot.errors, 2); assert.equal(result.candidates.bot.wins, 0);
});
