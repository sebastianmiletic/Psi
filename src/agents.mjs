import { watch } from 'node:fs';
import { cleanTerminal,redact } from './storage.mjs';
import { Type } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { Session } from './session.mjs';
import { atomicJSON,readJSON } from './storage.mjs';
import { shellCommand } from './battlecode.mjs';
import { workerDirectory } from './worker-storage.mjs';
export class Agents {
 constructor(app){this.app=app;this.home=app.home;this.session=app.session;this.tracked=new Map();this.controller=new AbortController();this.spawnQueue=Promise.resolve();}
 async records(){return this.session.state.agents||[];}
 directory(r){return workerDirectory(this.home,this.session.meta.id,r.sessionId);}
 spawn(args,signal){const next=this.spawnQueue.then(()=>this.launch(args,signal));this.spawnQueue=next.catch(()=>{});return next;}
 async launch({profile,prompt,name,mode,why,files=[],checks=[]},signal){
  signal?.throwIfAborted();
  const a=this.app,c=a.engine.config;if(!c.overkill)throw new Error('Enable OVERKILL with Tab inside /effort first.');if(c.subagentDepth>=1)throw new Error('Subagents cannot create nested subagents.');
  const spec=profile?c.agents.find(p=>p.id===profile):null;if(profile&&!spec)throw new Error('Unknown agent profile. Omit profile for a general worker, or configure presets in /subagents.');
  if(!prompt?.trim())throw new Error('A concrete task prompt is required.');
  if(mode&&!['plan','execute'].includes(mode))throw new Error('Worker mode must be plan or execute.');
  const displayName=workerName(name,await this.records());
  const taskHash=createHash('sha256').update(prompt.replace(/\s+/g,' ').trim().toLowerCase()).digest('hex');
  const ownership=await Promise.all(files.map(path=>a.tools.policy.check(path,{internal:false,write:true})));
  const workerMode=c.agentMode==='plan'?'plan':mode||spec?.mode||'execute';
  const active=[];for(const r of await this.records()){const j=await a.jobs.get(r.jobId).catch(()=>null);if(j&&['running','queued'].includes(j.status))active.push(r);}
  if(active.some(r=>(r.taskHash||createHash('sha256').update(String(r.prompt||'').replace(/\s+/g,' ').trim().toLowerCase()).digest('hex'))===taskHash))throw new Error('This task already has an active worker. Use its status or send a follow-up rather than duplicating it.');
  if(workerMode==='execute'&&ownership.length){const {within}=await import('./directories.mjs');if(active.some(r=>r.mode==='execute'&&(r.files||[]).some(path=>ownership.some(next=>within(path,next)||within(next,path)))))throw new Error('Another active worker owns an overlapping path. Assign disjoint files or wait for that worker.');}
  if(active.length>=c.subagentConcurrency)throw new Error(`All ${c.subagentConcurrency} subagent slots are occupied. Await a worker first.`);
  const child=await Session.create(a.session.meta.cwd,this.home,{parentSession:a.session.meta.id}),id=randomUUID(),manifest=join(child.dir,'worker.json');
  await child.rename(displayName);
  await child.event({type:'state',state:{directories:await a.tools.policy.roots()}});
  const model=spec?.model||c.model;a.registry.find(model);
  const remaining=c.budget>0?Math.max(0,c.budget-a.session.totals.cost):0;if(c.budget>0&&remaining===0)throw new Error('The parent budget is exhausted.');
  const cap=Math.min(spec?.budget>0?spec.budget:Infinity,remaining?remaining/c.subagentConcurrency:Infinity);
  const config={...c,model,effort:spec?.effort||c.effort,agentMode:workerMode,subagentDepth:(c.subagentDepth||0)+1,overkill:false,maxSteps:spec?.maxSteps||32,budget:Number.isFinite(cap)?cap:0};
  await atomicJSON(manifest,{parentSession:a.session.meta.id,sessionId:child.meta.id,home:this.home,config,checks,prompt:`Task from parent:\n${prompt}\n${why?'Delegation purpose: '+why+'\n':''}${ownership.length?'Assigned files: '+ownership.join(', ')+'\n':''}${checks.length?'Success checks: '+checks.join('; ')+'\n':''}\nReport the outcome, changed files, exact verification commands/results and unresolved limitations concisely. Include evidence paths; do not call a failed check successful.\nStay within the inherited directories and assigned files. Report concrete evidence and limitations. Do not release or activate a bot unless this specific task explicitly requests it.`});
  const workerArgv=[process.execPath,fileURLToPath(new URL('./agent-worker.mjs',import.meta.url)),manifest];
  signal?.throwIfAborted();
  const job=await a.jobs.start(shellCommand(workerArgv),a.session.meta.cwd,{label:`agent:${displayName}`,infrastructure:workerArgv,graceful_stop_ms:360000});
  const record={id,profile:profile||null,name:displayName,prompt,taskHash,why,files:ownership,checks,mode:workerMode,model,sessionId:child.meta.id,jobId:job.id,createdAt:new Date().toISOString()};await a.session.event({type:'state',state:{agents:[...await this.records(),record]}});if(signal?.aborted){await a.jobs.stop(job.id);signal.throwIfAborted();}a.event({type:'agent_started',agent:{...record,status:'running'}});this.track(record);return record;
 }
 async get(id){const r=(await this.records()).find(r=>r.id===id);if(!r)throw new Error('Unknown subagent ID.');return r;}
 async status(id){const r=await this.get(id),job=await this.app.jobs.get(r.jobId),result=await readJSON(join(await this.directory(r),'worker-result.json'),null);return{...r,status:job.status,result};}
 async collect(r){
  const child=new Session(this.home,{id:r.sessionId,parentSession:this.session.meta.id});child.dir=await this.directory(r);for await(const e of child.events())if(e.type==='usage'&&!this.session.seenUsage.has(`agent:${r.id}:${e.requestId}`))await this.session.event({...e,originalRequestId:e.originalRequestId||e.requestId,sourceAt:e.sourceAt||e.at,requestId:`agent:${r.id}:${e.requestId}`});
 }
 track(r){
  const key=`${r.id}:${r.jobId}`;if(this.tracked.has(key))return this.tracked.get(key);
  let watcher,timer,reading=false,finished=false;
  const directory=this.directory(r);
  const activity=async()=>{if(reading||finished||this.controller.signal.aborted)return;reading=true;try{const status=await readJSON(join(await directory,'activity.json'),null);if(status&&!finished&&!this.controller.signal.aborted)this.app.event({type:'agent_status',agent:{...r,status:'running',activity:status.activity}});}catch{}finally{reading=false;}};
  void directory.then(dir=>{if(finished||this.controller.signal.aborted)return;try{watcher=watch(dir,(event,file)=>{if(String(file)==='activity.json'){clearTimeout(timer);timer=setTimeout(()=>void activity(),100);timer.unref();}});watcher.on('error',()=>watcher.close());}catch{}});
  const done=this.app.jobs.awaitCompletion(r.jobId,this.controller.signal).then(async()=>{
   finished=true;watcher?.close();clearTimeout(timer);await this.collect(r);const result=await this.status(r.id);this.app.event({type:'agent_finished',agent:result});return result;
  }).finally(()=>{watcher?.close();clearTimeout(timer);});
  // A detached worker can survive a closed UI; stop observing without an unhandled rejection.
  void done.catch(()=>{});this.tracked.set(key,done);return done;
 }
 async restore(){for(const r of (await this.records()).slice(-32)){const j=await this.app.jobs.get(r.jobId).catch(()=>null);if(!j)continue;this.app.event({type:'agent_status',agent:{...r,status:j.status}});if(['running','queued'].includes(j.status))this.track(r);}}
 async dispose(){this.controller.abort(new Error('Worker observer closed'));await Promise.allSettled([...this.tracked.values()]);}
 async wait(id,signal){
  const r=await this.get(id),done=this.track(r);if(!signal)return done;
  signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason||new Error('Stopped'));signal.addEventListener('abort',abort,{once:true});done.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
 }
 async unreported(){const delivered=new Set(this.session.state.workerDeliveries||[]);return(await this.records()).filter(r=>!delivered.has(`${r.id}:${r.jobId}`));}
 async reports({wait=false,signal}={}){
  const rows=[];
  for(const r of await this.unreported()){
   const job=await this.app.jobs.get(r.jobId);if(['running','queued'].includes(job.status)&&!wait)continue;
   const result=await this.wait(r.id,signal);rows.push({key:`${r.id}:${r.jobId}`,id:r.id,name:r.name,status:result.status,summary:(result.result?.summary||result.result?.error||'No report; inspect the subagent journal.').slice(0,4000),report:join(await this.directory(r),'worker-result.json'),usage:result.result?.totals,verification:result.result?.verification});
  }
  return rows;
 }
 async delivered(rows){if(rows.length)await this.session.event({type:'state',state:{workerDeliveries:[...new Set([...(this.session.state.workerDeliveries||[]),...rows.map(r=>r.key)])]}});}
 async stopAll({wait=false}={}){for(const r of await this.records()){await this.app.jobs.stop(r.jobId).catch(()=>{});if(wait){await this.app.jobs.awaitCompletion(r.jobId).catch(()=>{});await this.collect(r);}}}
 send(id,prompt,signal){const next=this.spawnQueue.then(()=>{signal?.throwIfAborted();return this.sendTask(id,prompt);});this.spawnQueue=next.catch(()=>{});return next;}
 async sendTask(id,prompt){
  const r=await this.get(id),job=await this.app.jobs.get(r.jobId),dir=await this.directory(r);
  if(!['running','queued'].includes(job.status)){
   const active=(await Promise.all((await this.records()).map(async record=>({record,job:await this.app.jobs.get(record.jobId).catch(()=>null)})))).filter(row=>row.job&&['running','queued'].includes(row.job.status));if(active.length>=this.app.engine.config.subagentConcurrency)throw new Error('Await an existing worker before restarting this one.');
   const taskHash=createHash('sha256').update(prompt.replace(/\s+/g,' ').trim().toLowerCase()).digest('hex');
   if(active.some(({record})=>record.taskHash===taskHash))throw new Error('This follow-up is already assigned to an active worker.');
   if(this.app.engine.config.agentMode!=='plan'&&r.mode==='execute'&&r.files?.length){const {within}=await import('./directories.mjs');if(active.some(({record})=>record.mode==='execute'&&(record.files||[]).some(path=>r.files.some(next=>within(path,next)||within(next,path)))))throw new Error('Another active worker owns an overlapping path. Wait before restarting this worker.');}
   const child=await Session.load(r.sessionId,this.home,{parentSession:this.session.meta.id});await child.event({type:'state',state:{directories:await this.app.tools.policy.roots()}});
   const path=join(dir,'worker.json'),spec=await readJSON(path,null);spec.prompt=prompt;spec.config.agentMode=this.app.engine.config.agentMode==='plan'?'plan':spec.config.agentMode;
   await child.event({type:'state',state:{settings:{...child.state.settings,agentMode:spec.config.agentMode}}});await atomicJSON(path,spec);
   const workerArgv=[process.execPath,fileURLToPath(new URL('./agent-worker.mjs',import.meta.url)),path];
   const next=await this.app.jobs.start(shellCommand(workerArgv),this.session.meta.cwd,{label:`agent:${r.name}`,infrastructure:workerArgv,graceful_stop_ms:360000});
   const updated={...r,prompt,taskHash,mode:spec.config.agentMode,jobId:next.id,createdAt:new Date().toISOString()};await this.session.event({type:'state',state:{agents:(await this.records()).map(a=>a.id===id?updated:a)}});this.app.event({type:'agent_started',agent:{...updated,status:'running'}});this.track(updated);return{id,restarted:true};
  }
  const path=join(dir,'inbox.json'),inbox=await readJSON(path,[]);inbox.push({id:randomUUID(),text:prompt});await atomicJSON(path,inbox);return{queued:true,id};
 }
 async view(r){
  const state=await this.status(r.id);return{id:r.id,name:r.name,status:state.status,model:r.model,mode:r.mode,files:r.files||[],summary:(state.result?.summary||state.result?.error||'').slice(0,4000),verification:state.result?.verification,report:join(await this.directory(r),'worker-result.json'),usage:state.result?.totals};
 }
 register(){const tools=this.app.tools,str=Type.String();tools.add('agent','Delegate any concrete task to an OVERKILL worker after deciding useful independent work. Spawn requires a unique task name of 1 to 5 words, a concrete prompt and why delegation helps. Optionally reserve disjoint files and state success checks. No workers start automatically. Omit profile to use the main model or select a configured model/effort preset; profiles do not restrict task roles. Choose plan or execute mode. List, send follow-up, status, await without polling or stop. Workers inherit directory boundaries, cannot nest, and plan-mode parents force read-only children.',{action:Type.Union(['list','spawn','send','status','await','stop'].map(Type.Literal)),profile:Type.Optional(str),name:Type.Optional(Type.String({minLength:1,maxLength:64})),why:Type.Optional(Type.String({minLength:1,maxLength:1000})),files:Type.Optional(Type.Array(str,{maxItems:50})),checks:Type.Optional(Type.Array(str,{maxItems:20})),mode:Type.Optional(Type.Union(['plan','execute'].map(Type.Literal))),prompt:Type.Optional(str),id:Type.Optional(str)},async(a,signal)=>{
  if(a.action==='list')return{profiles:this.app.engine.config.agents.map(({id,name,model,effort,mode,maxSteps,budget})=>({id,name,model:model||'main',effort,mode,maxSteps,budget:budget||0})),runs:await Promise.all((await this.records()).map(async r=>{const {summary,verification,...view}=await this.view(r);return view;}))};
  if(a.action==='spawn'){if(!a.why?.trim())throw new Error('Explain briefly why this independent assignment benefits from delegation.');if(!a.prompt?.trim())throw new Error('A concrete task prompt is required.');return this.spawn(a,signal);}
  const r=await this.get(a.id);
  if(a.action==='status')return this.view(r);if(a.action==='await'){await this.wait(a.id,signal);return this.view(await this.get(a.id));}if(a.action==='stop'){await this.app.jobs.stop(r.jobId);return this.status(a.id);}
  if(a.action==='send'){if(!a.prompt?.trim())throw new Error('A follow-up prompt is required.');return this.send(a.id,a.prompt,signal);}
 });}
}

export function workerName(value,records=[]){
 const name=cleanTerminal(redact(value||'')).replace(/\s+/g,' ').trim();
 if(!name||name.split(/\s+/).length>5||Array.from(name).length>64)throw new Error('Give this subagent a descriptive task name of 1 to 5 words, up to 64 characters.');
 if(/^(?:agent|subagent|worker|researcher|reviewer|builder)(?:[ -]*\d+)?$/i.test(name))throw new Error('Name the actual task, such as Build replay viewer, rather than a generic role.');
 const key=text=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 if(!key(name))throw new Error('Use words describing the assigned task.');
 if(records.some(r=>key(r.name||'')===key(name)))throw new Error(`A subagent is already named ${name}. Choose a different task-specific name.`);
 return name;
}
