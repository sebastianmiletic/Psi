#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSweep } from '../src/sweep.mjs';
const controller = new AbortController();
process.on('SIGINT', () => controller.abort(new Error('Benchmark interrupted. Resume with the same manifest and output.')));
process.on('SIGTERM', () => controller.abort(new Error('Benchmark terminated.')));
try {
  const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const result = await runSweep(manifest, { signal: controller.signal, onProgress: e => console.error(`${e.completed} recorded · ${e.candidate} · ${e.status}`) });
  console.log(JSON.stringify(result, null, 2));
  if (result.changedArtifacts.length || Object.values(result.candidates).some(c => c.errors)) process.exitCode = 1;
} catch (e) { console.error(e.message); process.exitCode = controller.signal.aborted ? 130 : 1; }
