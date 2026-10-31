#!/usr/bin/env node
// Runs original Harness-Bench tasks with Psi, then calls its unchanged outcome oracles.
import { readFile,writeFile,mkdir,cp,readdir } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Accounts } from '../src/accounts.mjs';
import { importPi } from '../src/pi-import.mjs';
import { version,run } from '../src/updates.mjs';
const {values:v}=parseArgs({options:{suite:{type:'string'},out:{type:'string'},task:{type:'string',multiple:true},account:{type:'string'},model:{type:'string'},python:{type:'string'}}});
const suite=resolve(v.suite||join(homedir(),'.cache/psi/harness-bench')),root=fileURLToPath(new URL('..',import.meta.url)),out=resolve(v.out||join(root,'benchmarks/artifacts',new Date().toISOString().replaceAll(':','-'))),model=v.model||'openai-codex/gpt-5.6-sol',python=v.python||'/opt/homebrew/opt/python@3.12/bin/python3.12';
await mkdir(out,{recursive:true,mode:0o700});const names=await readdir(join(suite,'tasks')),chosen=(v.task||['009','010','028']).map(id=>names.find(n=>n===id||n.startsWith(id+'-')));if(chosen.some(x=>!x))throw new Error('Unknown task ID');
const sourceCommit=await run('git',['rev-parse','HEAD'],suite),psiCommit=await run('git',['rev-parse','HEAD'],root),results=[];
for(const id of chosen){
 const dir=join(out,id),workspace=join(dir,'workspace'),home=join(dir,'psi-home');await mkdir(dir,{recursive:true});await cp(join(suite,'tasks',id,'workspace'),workspace,{recursive:true,errorOnExist:true,force:false});
 if(v.account)await importPi(new Accounts(home),join(homedir(),'.pi/agent/pi-accounts.json'),[v.account]);
 const instruction=(await readFile(join(suite,'tasks',id,'instruction.md'),'utf8')).replaceAll('$WORKSPACE',workspace);
 const prompt=instruction+'\n\nWork only in this workspace. Do not access the benchmark source, hidden tests, reference solutions or graders. Complete the requested artifacts and report actual verification and limitations.';
 const start=Date.now(),trace=join(dir,'psi-events.jsonl');console.log(`Starting ${id} with ${model}`);
 const {code,output}=await new Promise((res,rej)=>{const child=spawn(process.execPath,[join(root,'bin/psi.mjs'),'-C',workspace,'--mode','execute','--profile','general','--model',model,'--effort','medium','--tokens','8192','--max-steps','80','--json','--no-debug','-p',prompt],{env:{...process.env,PSI_HOME:home},stdio:['ignore','pipe','pipe']});let output='',err='';const timer=setTimeout(()=>child.kill('SIGTERM'),600000);child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>err+=c);child.on('error',rej);child.on('close',code=>{clearTimeout(timer);res({code,output:output+(err?'\n'+JSON.stringify({stderr:err}):'')});});});
 await writeFile(trace,output,{mode:0o600});let usage={input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,requests:0};for(const line of output.split('\n'))try{const e=JSON.parse(line);if(e.type==='usage'&&e.totals)usage=e.totals;}catch{}
 const gradePath=join(dir,'grade.json');await run(python,[join(root,'benchmarks/score_harness_bench.py'),suite,id,workspace,gradePath],root);const grade=JSON.parse(await readFile(gradePath,'utf8'));
 const result={task:id,exitCode:code,wallSeconds:(Date.now()-start)/1000,usage,outcomeScore:grade.outcome_score,taskSuccess:grade.task_success,checks:grade.checks,gradeSha256:createHash('sha256').update(await readFile(gradePath)).digest('hex')};results.push(result);console.log(`${id}: score ${result.outcomeScore}, ${usage.requests} requests`);
 await writeFile(join(out,'summary.json'),JSON.stringify({benchmark:'Qihoo360/harness-bench',sourceCommit,psiCommit,psiVersion:version,model,effort:'medium',trialsPerTask:1,environment:'macOS native isolated workspaces; original unchanged oracles; complementary smoke subset, not standard Docker/ABI run',results},null,2)+'\n');
}
console.log(join(out,'summary.json'));
