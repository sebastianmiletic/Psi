import { cp,mkdir,readdir,rename,rm,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Session } from './session.mjs';
import { Jobs } from './jobs.mjs';
import { atomicJSON,readJSON,withLock } from './storage.mjs';

export async function workerDirectory(home,parent,id){
 const nested=Session.path(home,id,parent);
 return await stat(join(nested,'meta.json')).catch(()=>null)?nested:Session.path(home,id);
}

// Copy under both locks, expose only a complete copy, then remove the legacy folder.
// Running workers remain where they are until their next idle migration.
export async function migrateWorkers(home){
 const migrated=[],skipped=[];let jobs;
 for(const {name:id} of (await readdir(join(home,'sessions'),{withFileTypes:true}).catch(()=>[])).filter(e=>e.isDirectory())){
  if(!/^[\w.-]+$/.test(id))continue;
  const source=Session.path(home,id),spec=await readJSON(join(source,'worker.json'),null);if(!spec?.parentSession)continue;
  const parent=spec.parentSession;if(!/^[\w.-]+$/.test(parent)||!await stat(join(Session.path(home,parent),'meta.json')).catch(()=>null))continue;
  jobs ||= await new Jobs(home).list();
  if(jobs.some(j=>['running','queued'].includes(j.status)&&(j.sessionId===id||j.infrastructureArgv?.includes(join(source,'worker.json'))))){skipped.push(id);continue;}
  try{
   await withLock(join(Session.path(home,parent),'run.lock'),async()=>{
    let copied=false;
    await withLock(join(source,'run.lock'),async()=>{
     const destination=Session.path(home,id,parent);
     if(await stat(destination).catch(()=>null)){skipped.push(id);return;}
     const stage=destination+'.migrating-'+randomUUID();await mkdir(join(Session.path(home,parent),'agents'),{recursive:true,mode:0o700});
     try{
      await cp(source,stage,{recursive:true,filter:path=>path!==join(source,'run.lock')});
      const meta=await readJSON(join(stage,'meta.json'),null);if(!meta)throw new Error('Missing worker metadata');
      await atomicJSON(join(stage,'meta.json'),{...meta,parentSession:parent,migratedFrom:source});
      await atomicJSON(join(stage,'worker.json'),{...spec,parentSession:parent});
      await rename(stage,destination);copied=true;
     }finally{await rm(stage,{recursive:true,force:true});}
    },{timeout:0});
    if(copied){await rm(source,{recursive:true,force:true,maxRetries:10,retryDelay:50});migrated.push({id,parent});}
   },{timeout:0});
  }catch(e){if(/Another Psi process holds/.test(e.message)){skipped.push(id);continue;}throw e;}
 }
 return{migrated,skipped};
}
