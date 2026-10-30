import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, appendFile, mkdir, truncate } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { atomicJSON, readJSON, withLock } from './storage.mjs';

async function sha256(path) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const expand = (text, vars) => text.replace(/\{([\w]+)\}/g, (_, name) => { if (!(name in vars)) throw new Error(`Unknown command placeholder {${name}}`); return String(vars[name]); });

export async function runSweep(manifest, { cwd = process.cwd(), signal, onProgress = () => {} } = {}) {
  if (!Array.isArray(manifest.command) || !manifest.command.length || !manifest.command.every(x => typeof x === 'string')) throw new Error('Benchmark command must be an argv array.');
  if (!manifest.candidates?.length || !manifest.seeds?.length) throw new Error('Benchmark requires candidates and seeds.');
  if (new Set(manifest.candidates.map(c => c.name)).size !== manifest.candidates.length) throw new Error('Candidate names must be unique.');
  const workers = manifest.workers ?? Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));
  if (!Number.isInteger(workers) || workers < 1 || workers > 256) throw new Error('workers must be an integer from 1 to 256.');
  const output = resolve(cwd, manifest.output || `.psi/benchmarks/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(output, { recursive: true });
  return withLock(join(output, 'sweep.lock'), async () => {
    const candidates = await Promise.all(manifest.candidates.map(async c => {
      if (!c.name || !c.artifact) throw new Error('Each candidate needs name and artifact.');
      const artifact = resolve(cwd, c.artifact); return { ...c, artifact, sha256: await sha256(artifact) };
    }));
    const inputs = await Promise.all((manifest.inputs || []).map(async path => ({ path: resolve(cwd, path), sha256: await sha256(resolve(cwd, path)) })));
    const frozen = { inputs, metadata: manifest.metadata || {}, command: manifest.command, candidates, seeds: manifest.seeds, sides: manifest.sides || [0, 1], maps: manifest.maps || ['default'], repeats: manifest.repeats || 1, timeoutMs: manifest.timeoutMs || 0 };
    if (!Number.isInteger(frozen.repeats) || frozen.repeats < 1 || frozen.repeats > 10000 || !frozen.sides.length || !frozen.maps.length) throw new Error('Invalid repeats, sides or maps.');
    const signature = digest(frozen);
    const previous = await readJSON(join(output, 'sweep.json'), null);
    if (previous && previous.signature !== signature) throw new Error('Benchmark manifest or candidate hashes changed. Choose a fresh output directory.');
    if (!previous) await atomicJSON(join(output, 'sweep.json'), { signature, frozen, cwd, createdAt: new Date().toISOString() });
    const resultsPath = join(output, 'results.jsonl');
    const raw = await readFile(resultsPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    const completed = new Map();
    let durable = raw;
    if (raw && !raw.endsWith('\n')) { durable = raw.slice(0, raw.lastIndexOf('\n') + 1); await truncate(resultsPath, Buffer.byteLength(durable)); }
    const lines = durable.split('\n').filter(Boolean);
    for (const line of lines) { let r; try { r = JSON.parse(line); } catch { throw new Error('Benchmark journal is damaged; preserve it and choose a new output directory.'); } completed.set(r.key, r); }
    const tasks = []; const planned = new Set(completed.keys());
    for (const c of candidates) for (const map of frozen.maps) for (const seed of frozen.seeds) for (const side of frozen.sides) for (let repeat = 0; repeat < frozen.repeats; repeat++) {
      const vars = { ...c.params, candidate: c.artifact, name: c.name, map, seed, side, repeat };
      const key = digest(vars).slice(0, 24); if (!planned.has(key)) { planned.add(key); tasks.push({ key, candidate: c.name, sha256: c.sha256, map, seed, side, repeat, argv: manifest.command.map(arg => expand(arg, vars)) }); }
    }
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let index = 0, writeChain = Promise.resolve();
    const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, tasks.length) }, async () => {
      try { while (index < tasks.length) {
        signal?.throwIfAborted(); const task = tasks[index++];
        const result = await runMatch(task, { cwd, output, signal, timeoutMs: frozen.timeoutMs });
        if (signal?.aborted) throw signal.reason || new Error('Benchmark interrupted.');
        writeChain = writeChain.then(() => appendFile(resultsPath, JSON.stringify(result) + '\n', { mode: 0o600 }));
        await writeChain; completed.set(task.key, result); onProgress({ completed: completed.size, pending: tasks.length - index, candidate: task.candidate, status: result.status });
      } } catch (e) { controller.abort(e); throw e; }
    }));
    const failed = settled.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    const changed = [];
    for (const input of inputs) if (await sha256(input.path) !== input.sha256) changed.push(input.path);
    for (const c of candidates) if (await sha256(c.artifact) !== c.sha256) changed.push(c.name);
    const summary = { signature, output, total: completed.size, changedArtifacts: changed, evidence: changed.length ? 'invalid: candidate artifact changed during sweep' : 'local comparative evidence; competition strength is not established', candidates: {} };
    for (const result of completed.values()) {
      const c = summary.candidates[result.candidate] ||= { games: 0, wins: 0, losses: 0, draws: 0, unscored: 0, errors: 0 };
      c.games++;
      if (result.status !== 'completed') c.errors++;
      else if (result.result?.outcome === 'win') c.wins++;
      else if (result.result?.outcome === 'loss') c.losses++;
      else if (result.result?.outcome === 'draw') c.draws++;
      else c.unscored++;
    }
    await atomicJSON(join(output, 'summary.json'), summary); return summary;
  }, { signal, timeout: 1000 });
}
async function runMatch(task, { cwd, output, signal, timeoutMs }) {
  signal?.throwIfAborted();
  const log = join(output, `${task.key}.log`); const stream = createWriteStream(log, { mode: 0o600 });
  const started = Date.now(); let stdout = '', bytes = 0, reason, timer, escalation;
  const child = spawn(task.argv[0], task.argv.slice(1), { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  function stop(cause) {
    if (reason) return; reason = cause;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000); escalation.unref();
  }
  const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
  if (timeoutMs > 0) timer = setTimeout(() => stop('timed_out'), timeoutMs);
  function outputChunk(chunk, out) {
    if (out) stdout = (stdout + chunk.toString()).slice(-64000);
    if (bytes < 16_000_000) {
      const remaining = 16_000_000 - bytes; const part = chunk.subarray(0, remaining); bytes += part.length;
      if (!stream.write(part)) { child.stdout.pause(); child.stderr.pause(); stream.once('drain', () => { child.stdout.resume(); child.stderr.resume(); }); }
    }
  }
  child.stdout.on('data', chunk => outputChunk(chunk, true)); child.stderr.on('data', chunk => outputChunk(chunk, false));
  let error;
  child.on('error', e => { error = e.message; });
  const exit = await new Promise(res => child.on('close', (code, sig) => res({ code, signal: sig })));
  clearTimeout(timer); signal?.removeEventListener('abort', abort);
  await new Promise(res => stream.end(res));
  // Kill descendants left in the isolated group, including those holding no stdio pipes.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  clearTimeout(escalation);
  let result;
  for (const line of stdout.trim().split('\n').reverse()) { try { const parsed = JSON.parse(line); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { result = parsed; break; } } catch {} }
  return { ...task, status: reason || (error || exit.code !== 0 ? 'failed' : 'completed'), exitCode: exit.code, signal: exit.signal, error, result, log, durationMs: Date.now() - started, finishedAt: new Date().toISOString() };
}
