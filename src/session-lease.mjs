import {join} from 'node:path';
import {Session} from './session.mjs';
import {inspectLock,withLock} from './storage.mjs';

export async function sessionInUse(id,home){
 const dir=Session.path(home,id);
 for(const name of ['ui.lock','run.lock']){
  const lock=await inspectLock(join(dir,name));
  if(lock.exists&&!lock.stale&&lock.owner?.kind!=='storage-maintenance')return true;
 }
 return false;
}
export async function claimSessionUI(session,{timeout=0}={}){
 // Serialize claims with run/discard operations, then retain only the UI lease.
 return withLock(join(session.dir,'run.lock'),async()=>{
  let release,acquired;
  const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>acquired=resolve);
  const task=withLock(join(session.dir,'ui.lock'),async()=>{acquired();await held;},{timeout});
  // Observe acquisition failures immediately, without leaving an unhandled task.
  await Promise.race([ready,task]);
  let released=false;
  return{sessionId:session.meta.id,async release(){if(!released){released=true;release();}await task;}};
 },{timeout});
}
export const sessionBusyMessage='This chat is open or running in another terminal. Run psi --new for a separate chat.';
