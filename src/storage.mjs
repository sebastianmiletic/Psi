import { mkdir, readFile, writeFile, rename, open, unlink, stat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import {processIdentity,ownProcessIdentity} from './process-identity.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const psiHome = () => resolve(process.env.PSI_HOME || join(homedir(), '.psi'));
export async function privateDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); }
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path}: ${e.message}`); }
}
export async function replaceFile(source,target,{renameImpl=rename,retrySharingViolations=process.platform==='win32'}={}) {
  for(let attempt=0;;attempt++)try{await renameImpl(source,target);return;}catch(e){
    if(!retrySharingViolations||!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=20)throw e;
    await delay(Math.min(250,10*2**attempt));
  }
}
export async function atomicJSON(path, value, options={}) {
  await privateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await replaceFile(tmp,path,options);
  }
  finally { await unlink(tmp).catch(() => {}); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Missing/malformed ownership is briefly protected while a newly created file is written.
export const LOCK_WRITE_GRACE=30_000;
export async function inspectLock(path){
  let handle;
  try{handle=await open(path,'r');}catch(e){if(e.code==='ENOENT')return{exists:false};throw e;}
  let info,owner;
  try{info=await handle.stat();try{owner=JSON.parse(await handle.readFile('utf8'));}catch{}}
  finally{await handle.close();}
  let stale=false;
  if(!Number.isInteger(owner?.pid)||owner.pid<=0)stale=Date.now()-info.mtimeMs>LOCK_WRITE_GRACE;
  else if(!alive(owner.pid))stale=true;
  else{
    const identity=owner.pid===process.pid?await ownProcessIdentity():await processIdentity(owner.pid);
    if(identity){
      // Old releases wrote only a PID. A process born after that file cannot own it.
      stale=!identity.running||(owner.processKey?owner.processKey!==identity.key:identity.startedAt>info.mtimeMs+1000);
    }
    // If OS metadata is unavailable, retain the live PID rather than steal a writer.
  }
  return{exists:true,stale,owner,info};
}
async function reclaimLock(path){
  let release;
  try{release=await lockfile.lock(path,{realpath:false,lockfilePath:path+'.reclaim',stale:30000,retries:0});}
  catch(e){if(e.code==='ELOCKED')return false;throw e;}
  try{
    // Reinspect inside the recovery mutex: a competing recoverer may have finished.
    const current=await inspectLock(path);
    if(current.stale){await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});return true;}
    return !current.exists;
  }finally{await release();}
}
export async function withLock(path, fn, { signal, timeout = 60_000, kind, waitForMaintenance = true } = {}) {
  await privateDir(dirname(path));
  const start = Date.now(),identity=await ownProcessIdentity(),token=randomUUID();
  let handle;
  while (!handle) {
    let maintenanceOwner=false;
    signal?.throwIfAborted();
    try{
      handle=await open(path,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({pid:process.pid,token,...(identity?{processKey:identity.key}:{}),...(kind?{kind}:{})}));}
      catch(e){await handle.close();handle=null;await unlink(path).catch(()=>{});throw e;}
    }catch(e){
      if(e.code!=='EEXIST')throw e;
      const current=await inspectLock(path);
      maintenanceOwner=current.owner?.kind==='storage-maintenance';
      if(!current.exists)continue;
      if(current.stale&&await reclaimLock(path))continue;
      if(Date.now()-start>=Math.max(timeout,maintenanceOwner&&waitForMaintenance?10000:0))throw new Error(`Another Psi process holds ${path}`);
      await delay(50,undefined,{signal});
    }
  }
  try{return await fn();}finally{
    await handle.close();
    // Never remove a successor's lock if this path was replaced during shutdown.
    const owner=await readJSON(path,null).catch(()=>null);
    if(owner?.token===token)await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
}
export const defaults = {
  model: 'openai-codex/gpt-5.6-sol', subagentModel: 'openai-codex/gpt-5.6-sol', effort: 'medium', profile: 'battlecode',
  maxSteps: 0, budget: 0, maxOutputTokens: 8192, contextFraction: 0.72,
  toolOutputChars: 16000, toolActivity:'compact', concurrency: 4, retries: 4, cacheRetention: 'long',
  debug: true, customProviders: [], accent: 'sage', showLogo: true, animations: true,
  autoSwitchAccounts: true, accountSwitchThreshold: 100, quotaRefreshSeconds: 15,
  fallbackModels: [], loopRetrySeconds: 30, showUsage: true, customPrices: {},
  agentMode:'execute', overkill:false, subagentDepth:0, checkForUpdates:true, autoUpdate:false, openAfterUpdate:false,
  claudeCli:'claude',
};
// Retired presets and worker-count settings must not restrict resumed chats.
export function withoutWorkerProfiles(config = {}) {
  const { agents, subagentConcurrency, ...current } = config || {};
  return current;
}
export async function loadConfig(home = psiHome()) { return withoutWorkerProfiles({ ...defaults, ...await readJSON(join(home, 'config.json'), {}) }); }
export async function saveConfig(patch, home = psiHome()) {
  return withLock(join(home, 'config.lock'), async () => {
    const next = withoutWorkerProfiles({ ...await loadConfig(home), ...patch });
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
