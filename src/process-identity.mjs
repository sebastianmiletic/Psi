import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let own;

// Read process metadata only; never collect command arguments or environment.
export async function processIdentity(pid){
  if(!Number.isInteger(pid)||pid<=0)return null;
  try{
    if(process.platform==='win32'){
      const script=`$p=Get-Process -Id ${pid} -ErrorAction Stop; @{started=$p.StartTime.ToUniversalTime().ToString('o');name=$p.ProcessName}|ConvertTo-Json -Compress`;
      const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:5000,windowsHide:true});
      const p=JSON.parse(stdout.trim());return{key:`${p.started}:${p.name}`,startedAt:Date.parse(p.started),running:true};
    }
    const {stdout}=await exec('ps',['-p',String(pid),'-o','lstart=','-o','stat=','-o','comm='],{timeout:2000,env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
    const m=stdout.trim().match(/^(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.+)$/);
    return m?{key:`${m[1].replace(/\s+/g,' ')}:${m[3]}`,startedAt:Date.parse(m[1]+' UTC'),running:!(/^[ZX]/.test(m[2]))}:null;
  }catch{return null;}
}
export function ownProcessIdentity(){return own??=processIdentity(process.pid);}
