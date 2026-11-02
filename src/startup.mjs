import {Session} from './session.mjs';
import {readJSON} from './storage.mjs';
import {join} from 'node:path';
import {canonical} from './directories.mjs';

export async function startupSession({home,cwd,resume,continueLatest=false,newSession=false,interactive=false,explicitDirectory=false}){
 if(resume)return Session.load(resume,home);
 if(newSession)return Session.create(cwd,home);
 if(continueLatest||interactive){
  const list=await Session.list(home),directory=await canonical(cwd);
  let latest;
  if(continueLatest||explicitDirectory){for(const row of list)if(await canonical(row.cwd)===directory){latest=row;break;}}
  else{const last=await readJSON(join(home,'last-session.json'),null);latest=list.find(s=>s.id===last?.id)||list[0];}
  if(latest)return Session.load(latest.id,home);
 }
 return Session.create(cwd,home);
}
