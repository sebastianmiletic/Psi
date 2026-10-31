import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readJSON, atomicJSON } from './storage.mjs';
import { sourceHashes, fileHash } from './battlecode.mjs';
const [manifestPath,key]=process.argv.slice(2),exp=await readJSON(manifestPath,null),op=exp.operations[key];
let child,stopping=false;
// The live controller defers termination until incumbent restoration is verified. Do not kill its parent early.
for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>{stopping=true;try{child?.kill('SIGTERM');}catch{}});
let result={ok:false,operationId:op.operationId,commands:op.commands,startedAt:new Date().toISOString()};
try {
  if((await sourceHashes(join(exp.candidate,'src'))).fingerprint!==op.source)throw new Error('Candidate changed before operation start');
  if(op.kind==='trial'){const hash=createHash('sha256').update(await readFile(join(exp.candidate,'.cambc/build-release/bot-injected.wasm'))).digest('hex');if(hash!==exp.correctness?.wasmHash)throw new Error('Candidate artifact changed before the live transaction');}
  for(const argv of op.commands) {
    do {
    const exit=await new Promise((res,rej)=>{child=spawn(argv[0],argv.slice(1),{cwd:exp.project,env:process.env,stdio:['ignore','inherit','inherit']});child.once('error',rej);child.once('close',(code,signal)=>res({code,signal}));});
    if(exit.code!==0)throw new Error(`Command failed (${exit.code ?? exit.signal})`);
    if(stopping)throw new Error('Operation cancelled after controller cleanup');
    const collected=op.kind==='collect'?await readJSON(join(op.out,'results.json'),null):null;
    if(op.kind!=='collect'||collected?.length===5)break;
    for(let i=0;i<5&&!stopping;i++)await delay(1000);
    if(stopping)throw new Error('Collection cancelled');
    }while(true);
  }
  if((await sourceHashes(join(exp.candidate,'src'))).fingerprint!==op.source)throw new Error('Candidate changed during operation');
  if(op.kind==='correctness')result.wasmHash=createHash('sha256').update(await readFile(join(exp.candidate,'.cambc/build-release/bot-injected.wasm'))).digest('hex');
  if(op.kind==='collect'){
    const rows=await readJSON(join(op.out,'results.json'),null);result.evidence={};
    for(const name of ['receipt.json','group.json','results.json','settled-state.json',...rows.map(r=>`replays/${r.match}.repl26a`)])result.evidence[name]=await fileHash(join(op.out,name));
  }
  result.ok=true;
} catch(e) {result.error=e.message;console.error(e.message);}
result.finishedAt=new Date().toISOString();await atomicJSON(join(dirname(manifestPath),`${op.operationId}.result.json`),result);
process.exitCode=result.ok?0:1;
