import {Session} from './session.mjs';
import {canonical} from './directories.mjs';
import {sessionInUse,claimSessionUI,sessionBusyMessage} from './session-lease.mjs';

export async function startupSession({home,cwd,resume,continueLatest=false,newSession=false,interactive=false}){
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
 if(continueLatest){
  const list=await Session.list(home),directory=await canonical(cwd);
  for(const row of list)if(await canonical(row.cwd)===directory)return load(row.id);
 }
 return Session.create(cwd,home);
}
