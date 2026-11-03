import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

// Keep terminal ownership with the newly installed process until it exits.
// Both processes receive terminal SIGINT, so the waiting parent must not exit first.
export async function runUpdatedPsi({entrypoint,args=[],cwd=process.cwd(),env=process.env,spawnImpl=spawn,signals=process}){
  if(typeof entrypoint!=='string'||!isAbsolute(entrypoint))throw new Error('The updated Psi entry point is missing. Run psi to open the installed version.');
  const child=spawnImpl(process.execPath,[entrypoint,...args],{cwd,env,stdio:'inherit'});
  const interrupt=()=>{},terminate=()=>{try{child.kill('SIGTERM');}catch{}};
  signals.on('SIGINT',interrupt);signals.on('SIGTERM',terminate);
  try{return await new Promise((accept,reject)=>{
    child.once('error',error=>reject(new Error('Update installed, but Psi could not open: '+error.message)));
    child.once('exit',code=>accept(code??1));
  });}finally{signals.removeListener('SIGINT',interrupt);signals.removeListener('SIGTERM',terminate);}
}

export async function maybeOpenAfterUpdate(result,config,{json=false,interactive=!!process.stdin.isTTY&&!!process.stdout.isTTY,open=runUpdatedPsi,...options}={}){
  if(config.openAfterUpdate!==true||!result.updated||result.preview||json||!interactive)return{opened:false};
  return{opened:true,exitCode:await open({entrypoint:result.entrypoint,...options})};
}
