import {Session} from './session.mjs';
import {readJSON} from './storage.mjs';
import {join} from 'node:path';
import {canonical} from './directories.mjs';
import {sessionInUse,claimSessionUI,sessionBusyMessage} from './session-lease.mjs';

export async function startupSession({home,cwd,resume,continueLatest=false,newSession=false,interactive=false,explicitDirectory=false}){
 const load=async id=>{
  if(await sessionInUse(id,home))throw new Error(sessionBusyMessage);
  let lease;
  try{
   if(interactive)lease=await claimSessionUI({dir:Session.path(home,id),meta:{id}});
   const session=await Session.load(id,home);session.uiLease=lease;return session;
  }catch(error){await lease?.release();throw error;}
 };
 if(resume)return load(resume);
 if(newSession)return Session.create(cwd,home);
 if(continueLatest||interactive){
  const list=await Session.list(home),directory=await canonical(cwd);
  let latest;
  if(continueLatest||explicitDirectory){for(const row of list)if(await canonical(row.cwd)===directory){latest=row;break;}}
  else{const last=await readJSON(join(home,'last-session.json'),null);latest=list.find(s=>s.id===last?.id)||list[0];}
  if(latest)try{return await load(latest.id);}catch(error){
   if(continueLatest||!interactive||!/another terminal|Another Psi process holds/.test(error.message))throw error;
   // A second terminal gets its own workspace/chat, without weakening writer locks.
  }
 }
 return Session.create(cwd,home);
}
