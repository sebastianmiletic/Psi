import {open,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function evidenceReceipt(path,{signal}={}){
 signal?.throwIfAborted();
 if(!(await stat(path)).isFile())throw new Error('Completion evidence must be a regular file: '+path);
 const handle=await open(path,'r');
 try{
  const before=await handle.stat();if(!before.isFile())throw new Error('Completion evidence must be a regular file: '+path);
  const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false})){signal?.throwIfAborted();hash.update(chunk);}
  const after=await handle.stat(),current=await stat(path);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||current.ino!==after.ino||current.size!==after.size||current.mtimeMs!==after.mtimeMs)throw new Error('Completion evidence changed while being verified: '+path);
  return{path,bytes:after.size,mtimeMs:after.mtimeMs,sha256:hash.digest('hex')};
 }finally{await handle.close();}
}

export class VerificationReceipts{
 constructor(){this.commands=new Map();}
 event(e){
  if(e.type==='tool_start'&&e.call.name==='bash')this.commands.set(e.call.id,{command:e.call.arguments.command,status:'running'});
  if(e.type!=='tool_end'||!['bash','job'].includes(e.call.name))return;
  let result;try{result=JSON.parse(e.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));}catch{}
  const entry=e.call.name==='bash'?this.commands.get(e.call.id):[...this.commands.values()].find(r=>r.jobId===(result?.id||e.call.arguments.id));if(!entry)return;
  entry.status=e.result.isError?'failed':result?.status||'unverified';if(result?.id)entry.jobId=result.id;if(Number.isInteger(result?.exitCode))entry.exitCode=result.exitCode;
 }
 report(checks=[]){
  const commands=[...this.commands.values()].slice(-20);
  const unverified=checks.filter(check=>!commands.some(c=>c.command.trim()===check.trim()&&c.status==='completed'&&c.exitCode===0));
  return{commands,requested:checks,unverified,failed:commands.filter(c=>c.status==='failed'||Number.isInteger(c.exitCode)&&c.exitCode!==0).length};
 }
}
