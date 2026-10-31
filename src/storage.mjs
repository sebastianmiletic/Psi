import { mkdir, readFile, writeFile, rename, open, unlink, stat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const psiHome = () => resolve(process.env.PSI_HOME || join(homedir(), '.psi'));
export async function privateDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); }
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path}: ${e.message}`); }
}
export async function atomicJSON(path, value) {
  await privateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, path); }
  finally { await unlink(tmp).catch(() => {}); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export async function withLock(path, fn, { signal, timeout = 60_000 } = {}) {
  await privateDir(dirname(path));
  const start = Date.now();
  let handle;
  while (!handle) {
    signal?.throwIfAborted();
    try { handle = await open(path, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const owner = await readJSON(path, null);
        if (owner?.pid && !alive(owner.pid)) { await unlink(path); continue; }
      } catch (e) {
        // An owner may still be writing its freshly created lock.
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30_000) await unlink(path).catch(() => {});
      }
      if (Date.now() - start >= timeout) throw new Error(`Another Psi process holds ${path}`);
      await delay(50, undefined, { signal });
    }
  }
  try { return await fn(); } finally { await handle.close(); await unlink(path).catch(() => {}); }
}
export const defaults = {
  model: 'openai-codex/gpt-5.6-sol', effort: 'medium', profile: 'battlecode',
  maxSteps: 0, budget: 0, maxOutputTokens: 8192, contextFraction: 0.72,
  toolOutputChars: 16000, concurrency: 4, retries: 4, cacheRetention: 'long',
  debug: true, customProviders: [], accent: 'sage', showLogo: true, animations: true,
  autoSwitchAccounts: false, accountSwitchThreshold: 100, quotaRefreshSeconds: 120,
  fallbackModels: [], loopRetrySeconds: 30, showUsage: true, customPrices: {},
};
export async function loadConfig(home = psiHome()) { return { ...defaults, ...await readJSON(join(home, 'config.json'), {}) }; }
export async function saveConfig(patch, home = psiHome()) {
  return withLock(join(home, 'config.lock'), async () => {
    const next = { ...await loadConfig(home), ...patch };
    await atomicJSON(join(home, 'config.json'), next); return next;
  });
}
export function cleanTerminal(text) {
  return String(text).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function redact(text) {
  return String(text).replace(/\b(?:sk-|sk-ant-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[redacted]');
}
export async function secureFile(path) { await chmod(path, 0o600); }

// Recover a torn final JSONL append without reading the entire long-running session into memory.
export async function durableJournalSize(path) {
  const handle = await open(path, 'r+').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!handle) return 0;
  try {
    const { size } = await handle.stat(); if (!size) return 0;
    const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] === 10) return size;
    let position = size;
    while (position > 0) {
      const start = Math.max(0, position - 65536); const chunk = Buffer.alloc(position - start);
      await handle.read(chunk, 0, chunk.length, start); const i = chunk.lastIndexOf(10);
      if (i >= 0) { const end = start + i + 1; await handle.truncate(end); return end; }
      position = start;
    }
    await handle.truncate(0); return 0;
  } finally { await handle.close(); }
}
