import { spawn } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, readJSON, alive, psiHome, privateDir } from './storage.mjs';

export class Jobs {
  constructor(home = psiHome(), sessionId) { this.home = home; this.sessionId = sessionId; this.dir = join(home, 'jobs'); }
  path(id) { if (!/^[\w-]+$/.test(id)) throw new Error('Invalid job ID.'); return join(this.dir, id); }
  async start(command, cwd, { timeout_ms = 0, label = 'shell', max_log_bytes = 128 * 1024 * 1024 } = {}) {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const dir = this.path(id); await privateDir(dir);
    const job = { id, sessionId: this.sessionId, label, command, cwd: resolve(cwd), status: 'queued', createdAt: new Date().toISOString(), timeout_ms, max_log_bytes, log: join(dir, 'output.log') };
    await atomicJSON(join(dir, 'job.json'), job);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./job-worker.mjs', import.meta.url)), dir], { detached: true, stdio: 'ignore', env: process.env });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    child.unref();
    await atomicJSON(join(dir, 'worker.json'), { pid: child.pid });
    return { ...job, pid: child.pid };
  }
  async get(id) {
    const job = await readJSON(join(this.path(id), 'job.json'), null);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (!job.pid) job.pid = (await readJSON(join(this.path(id), 'worker.json'), null))?.pid;
    if (['running', 'queued'].includes(job.status) && job.pid && !alive(job.pid)) {
      job.status = 'interrupted'; job.error = 'Worker exited before recording completion.';
      await atomicJSON(join(this.path(id), 'job.json'), job);
    }
    return job;
  }
  async list() {
    const ids = await readdir(this.dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return (await Promise.all(ids.map(id => this.get(id)))).sort((a, b) => b.id.localeCompare(a.id));
  }
  async tail(id, maxChars = 12000) {
    const job = await this.get(id);
    const f = await open(job.log, 'r').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!f) return '';
    try { const { size } = await f.stat(); const buf = Buffer.alloc(Math.min(size, maxChars * 4)); await f.read(buf, 0, buf.length, Math.max(0, size - buf.length)); return buf.toString('utf8').slice(-maxChars); }
    finally { await f.close(); }
  }
  async wait(id, ms = 1000, signal) {
    const end = Date.now() + Math.max(0, Math.min(ms, 60_000));
    let job;
    do { signal?.throwIfAborted(); job = await this.get(id); if (!['running', 'queued'].includes(job.status) || Date.now() >= end) return job; await delay(100, undefined, { signal }); } while (true);
  }
  async stop(id) {
    const job = await this.get(id);
    if (job.status === 'queued' && !job.pid) throw new Error('Job is starting. Try stop again in a moment.');
    if (!['running', 'queued'].includes(job.status)) return job;
    try { process.kill(-job.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const timer = setTimeout(() => { try { process.kill(-job.pid, 'SIGKILL'); } catch {} }, 2000); timer.unref();
    return this.wait(id, 1500);
  }
}
