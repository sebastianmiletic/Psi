import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { readJSON, atomicJSON } from './storage.mjs';

const dir = process.argv[2];
const path = join(dir, 'job.json');
const job = await readJSON(path, null);
if (!job) process.exit(1);
job.pid = process.pid; job.status = 'running'; job.startedAt = new Date().toISOString();
await atomicJSON(path, job);
const log = createWriteStream(job.log, { flags: 'a', mode: 0o600 });
let bytes = 0, capped = false, reason, timer, escalation;
const argv=job.sandbox?.argv||job.infrastructureArgv;
const child = spawn(argv?.[0] || process.env.SHELL || (process.platform==='win32'?process.env.COMSPEC||'cmd.exe':'/bin/sh'), argv?argv.slice(1):process.platform==='win32'?['/d','/s','/c',job.command]:['-lc', job.command], { cwd: job.cwd, env: job.sandbox?.env || {...process.env,PSI_JOB_CONTROL_DIR:dir}, stdio: ['ignore', 'pipe', 'pipe'] });
job.childPid = child.pid; await atomicJSON(path, job);
function output(chunk) {
  if (capped) return;
  const remaining = Math.max(0, job.max_log_bytes - bytes);
  const slice = chunk.subarray(0, remaining); bytes += slice.length;
  if (slice.length && !log.write(slice)) { child.stdout?.pause(); child.stderr?.pause(); log.once('drain', () => { child.stdout?.resume(); child.stderr?.resume(); }); }
  if (chunk.length > remaining) { capped = true; log.write('\n[Psi: log size limit reached; further output discarded.]\n'); }
}
child.stdout.on('data', output); child.stderr.on('data', output);
function terminate(cause) {
  if (reason) return;
  reason = cause;
  if(process.platform==='win32'){
    void atomicJSON(join(dir,'stop-request.json'),{reason:cause});
    escalation=setTimeout(()=>{const killer=spawn('taskkill',['/pid',String(process.pid),'/t','/f'],{stdio:'ignore',windowsHide:true});killer.on('error',()=>{});},job.graceful_stop_ms||2000);escalation.unref();return;
  }
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  escalation = setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, Math.max(1800,(job.graceful_stop_ms||2000)-200)); escalation.unref();
}
process.on('SIGTERM', () => terminate('cancelled'));
process.on('SIGINT', () => terminate('cancelled'));
if (job.timeout_ms > 0) timer = setTimeout(() => terminate('timed_out'), job.timeout_ms);
const stopMonitor=process.platform==='win32'?setInterval(()=>{void readJSON(join(dir,'stop-request.json'),null).then(r=>{if(r)terminate(r.reason||'cancelled');}).catch(()=>{});},200):null;
let spawnError;
child.on('error', e => { spawnError = e.message; output(Buffer.from(e.message + '\n')); });
child.on('close', async (code, signal) => {
  clearTimeout(timer);
  clearInterval(stopMonitor);
  job.status = reason || (spawnError || code !== 0 ? 'failed' : 'completed');
  job.exitCode = code; job.signal = signal; job.error = spawnError; job.logCapped = capped; job.bytes = bytes; job.finishedAt = new Date().toISOString();
  await new Promise(res => log.end(res));
  await atomicJSON(path, job);
  // Leave the escalation timer in place for descendants that ignore SIGTERM.
  if (reason && (job.graceful_stop_ms||2000) <= 2000) await new Promise(res => setTimeout(res, 2000));
  clearTimeout(escalation);
  process.exit(code === 0 ? 0 : 1);
});
