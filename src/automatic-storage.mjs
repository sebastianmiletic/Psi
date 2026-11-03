import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {readJSON,atomicJSON,withLock} from './storage.mjs';
import {compactStorage} from './storage-maintenance.mjs';

export const STORAGE_INTERVAL=30*60*1000,STORAGE_RETRY=5*60*1000;
const statePath=home=>join(home,'automatic-storage.json');

// One short-lived worker per home. No provider calls and no UI/process startup wait.
export async function runAutomaticStorage(home,{reason='scheduled',sessionId,requestedAt=Date.now(),now=()=>Date.now(),compact=compactStorage}={}){
  try{return await withLock(join(home,'automatic-storage.lock'),async()=>{
    const old=await readJSON(statePath(home),{}).catch(()=>({})),full=!(old.nextRunAt>now());
    if(!full&&reason!=='closed')return{skipped:true};
    if(reason==='closed'&&old.completedAt>=requestedAt&&!old.skipped?.includes(sessionId))return{skipped:true};
    try{
      const report=await compact(home,{only:!full&&reason==='closed'&&sessionId?[sessionId]:null,exclude:reason==='closed'||!sessionId?[]:[sessionId]});
      const skipped=full?report.skipped:[...new Set([...(old.skipped||[]).filter(id=>id!==sessionId),...report.skipped])];
      await atomicJSON(statePath(home),{schema:1,lastReason:reason,completedAt:now(),nextRunAt:full?now()+(skipped.length?STORAGE_RETRY:STORAGE_INTERVAL):old.nextRunAt,skipped});
      return report;
    }catch(error){
      await atomicJSON(statePath(home),{...old,schema:1,nextRunAt:now()+STORAGE_RETRY,error:{at:now(),message:error.message}});return{error:error.message};
    }
  },{timeout:reason==='closed'?60000:0});}
  catch(error){if(/Another Psi process holds/.test(error.message))return{skipped:true};throw error;}
}

export async function launchAutomaticStorage(home,{reason='scheduled',sessionId,requestedAt=Date.now()}={}, {spawnImpl=spawn}={}){
  if(reason!=='closed'){
    const state=await readJSON(statePath(home),null).catch(()=>null);
    if(state?.nextRunAt>Date.now())return false;
  }
  const child=spawnImpl(process.execPath,[fileURLToPath(import.meta.url),resolve(home),reason,sessionId||'',String(requestedAt)],{detached:true,windowsHide:true,stdio:'ignore'});
  await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();return true;
}

export class AutomaticStorage{
  constructor(home,{sessionId,launch=launchAutomaticStorage,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}){
    Object.assign(this,{home,sessionId,launch,setIntervalImpl,clearIntervalImpl});
  }
  kick(reason='scheduled',id=this.sessionId?.()){
    return Promise.resolve().then(()=>this.launch(this.home,{reason,sessionId:id,requestedAt:Date.now()})).catch(()=>false);
  }
  start(){if(this.started)return;this.started=true;void this.kick();this.timer=this.setIntervalImpl(()=>void this.kick(),STORAGE_RETRY);this.timer.unref?.();}
  async close(){if(!this.started)return;this.started=false;this.clearIntervalImpl(this.timer);await this.kick('closed');}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await runAutomaticStorage(resolve(process.argv[2]),{reason:process.argv[3],sessionId:process.argv[4]||undefined,requestedAt:Number(process.argv[5])}).catch(()=>{process.exitCode=1;});
}
