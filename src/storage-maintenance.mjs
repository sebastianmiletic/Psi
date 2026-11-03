import { stat, readdir, rename, rmdir, symlink, lstat, link } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from './session.mjs';
import { Jobs } from './jobs.mjs';
import { withLock, privateDir } from './storage.mjs';
import { compactJournal, compressFile } from './journal.mjs';
import { readPackedJSON, writePackedJSON, pruneWebCache } from './packed-json.mjs';

async function bytes(path) {
  const info = await lstat(path).catch(e => {if(e.code === 'ENOENT')return null;throw e;});
  if (!info || info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0; for (const name of await readdir(path)) total += await bytes(join(path,name)); return total;
}
async function storageBytes(dir) {
  let total = 0;
  for (const name of ['events.jsonl','history','debug.jsonl','debug.psi','diagnostics']) total += await bytes(join(dir,name));
  return total;
}
// Moving an idle disposable cache preserves its path through a symlink. Conflicting
// cache entries remain untouched; there is no overwrite or session-evidence cleanup.
export async function consolidateToolCache(home, dir) {
  const root = join(home,'tool-cache'); await privateDir(root);
  const local = join(dir,'scratch',process.platform === 'darwin' ? 'Library/Caches' : '.cache');
  const info = await lstat(local).catch(e => {if(e.code === 'ENOENT')return null;throw e;});
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  for (const name of await readdir(local)) {
    const source=join(local,name),sourceInfo=await lstat(source);if(sourceInfo.isSymbolicLink())continue;
    const target=join(root,name);
    if (await lstat(target).catch(e => {if(e.code === 'ENOENT')return null;throw e;})) continue;
    try{await rename(source,target);
      try{if(process.platform==='win32'&&!sourceInfo.isDirectory())await link(target,source);else await symlink(target,source,process.platform==='win32'?'junction':'dir');}
      catch(error){await rename(target,source);throw error;}
    }
    catch(e){if(e.code!=='EXDEV')throw e;}
  }
  if (!(await readdir(local)).length) {
    await rmdir(local); await symlink(root,local,process.platform==='win32'?'junction':'dir');
  }
}
export async function compactStorage(home,{only=null,exclude=[]}={}) {
  const report = {sessions:0,skipped:[],beforeBytes:0,afterBytes:0};
  const jobs=await new Jobs(home).list(),active=new Set(jobs.filter(j=>['running','queued'].includes(j.status)).map(j=>j.sessionId));
  for (const {id,dir,meta} of await Session.storageEntries(home)) {
    if(only&&!only.includes(id)&&!only.includes(meta.parentSession))continue;
    if(exclude.includes(id)||exclude.includes(meta.parentSession)||active.has(id)||active.has(meta.parentSession)){report.skipped.push(id);continue;}
    try {
      await withLock(join(dir,'ui.lock'),()=>withLock(join(dir,'run.lock'),async()=>{
        report.beforeBytes+=await storageBytes(dir);
        await compactJournal(dir,{force:true,repair:true});
        if(await stat(join(dir,'diagnostics')).catch(()=>null))await compactJournal(join(dir,'diagnostics'),{force:true,repair:true});
        if(await stat(join(dir,'debug.jsonl')).catch(()=>null))await compressFile(join(dir,'debug.jsonl'));
        await withLock(join(home,'tool-cache.lock'),()=>consolidateToolCache(home,dir));
        report.afterBytes+=await storageBytes(dir);report.sessions++;
      },{timeout:0,kind:'storage-maintenance',waitForMaintenance:false}),{timeout:0,kind:'storage-maintenance',waitForMaintenance:false});
    } catch(e) {if(/Another Psi process holds/.test(e.message))report.skipped.push(id);else throw e;}
  }
  await withLock(join(home,'stats.lock'),async()=>{
    const path=join(home,'stats-cache.json');if(await stat(path).catch(()=>null)){const cache=await readPackedJSON(path,null);if(cache)await writePackedJSON(path,cache);}
  });
  // The cache is disposable; preserve every saved artifact and historical response.
  const cacheDir=join(home,'web-cache');
  await privateDir(cacheDir);await pruneWebCache(home);
  await withLock(join(cacheDir,'cache.lock'),async()=>{
    for(const name of await readdir(cacheDir))if(/^[a-f0-9]{24}\.json$/.test(name)){
      const path=join(cacheDir,name),page=await readPackedJSON(path,null);if(page)await writePackedJSON(path,page);
    }
  });
  await pruneWebCache(home);return report;
}
