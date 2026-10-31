import { watch } from 'node:fs';
import { cleanTerminal,redact } from './storage.mjs';
import { Type } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Session } from './session.mjs';
import { atomicJSON,readJSON } from './storage.mjs';
import { shellCommand } from './battlecode.mjs';
export class Agents {
 constructor(app){this.app=app;this.home=app.home;this.session=app.session;this.tracked=new Map();this.controller=new AbortController();}
 async records(){return this.session.state.agents||[];}
 async spawn({profile,prompt,name,automatic=false,runId}){
  const a=this.app,c=a.engine.config;if(!c.overkill)throw new Error('Enable OVERKILL with Tab inside /effort first.');if(c.subagentDepth>=1)throw new Error('Subagents cannot create nested subagents.');
  const spec=c.agents.find(p=>p.id===profile);if(!spec)throw new Error('Unknown agent profile. Configure workers in /subagents or /settings.');
  const active=[];for(const r of await this.records()){const j=await a.jobs.get(r.jobId).catch(()=>null);if(j&&['running','queued'].includes(j.status))active.push(r);}
  if(active.length>=c.subagentConcurrency)throw new Error(`All ${c.subagentConcurrency} subagent slots are occupied. Await a worker first.`);
  const child=await Session.create(a.session.meta.cwd,this.home),id=randomUUID(),manifest=join(child.dir,'worker.json');
  await child.event({type:'state',state:{directories:await a.tools.policy.roots()}});
  const model=spec.model||c.model;a.registry.find(model);
  const remaining=c.budget>0?Math.max(0,c.budget-a.session.totals.cost):0;if(c.budget>0&&remaining===0)throw new Error('The parent budget is exhausted.');
  const cap=Math.min(spec.budget>0?spec.budget:Infinity,remaining?remaining/c.subagentConcurrency:Infinity);
  const config={...c,model,effort:spec.effort||c.effort,agentMode:automatic||c.agentMode==='plan'?'plan':spec.mode||'execute',subagentDepth:(c.subagentDepth||0)+1,overkill:false,maxSteps:spec.maxSteps||80,budget:Number.isFinite(cap)?cap:0};
  await atomicJSON(manifest,{parentSession:a.session.meta.id,sessionId:child.meta.id,home:this.home,config,prompt:`Assigned role: ${spec.name}\n${spec.job}\n\nTask from parent:\n${prompt}\n\nStay within the inherited directories and assigned files. Report concrete evidence and limitations. Do not release or activate a bot unless this specific task explicitly requests it.`});
  const displayName=name?cleanTerminal(redact(name)).slice(0,64):taskName(prompt,spec.name);
  const workerArgv=[process.execPath,fileURLToPath(new URL('./agent-worker.mjs',import.meta.url)),manifest];
  const job=await a.jobs.start(shellCommand(workerArgv),a.session.meta.cwd,{label:`agent:${displayName}`,infrastructure:workerArgv,graceful_stop_ms:360000});
  const record={id,profile,name:displayName,role:spec.name,prompt,model,automatic,runId,sessionId:child.meta.id,jobId:job.id,createdAt:new Date().toISOString()};await a.session.event({type:'state',state:{agents:[...await this.records(),record]}});a.event({type:'agent_started',agent:{...record,status:'running'}});this.track(record);return record;
 }
 async get(id){const r=(await this.records()).find(r=>r.id===id);if(!r)throw new Error('Unknown subagent ID.');return r;}
 async status(id){const r=await this.get(id),job=await this.app.jobs.get(r.jobId),result=await readJSON(join(this.home,'sessions',r.sessionId,'worker-result.json'),null);return{...r,status:job.status,result};}
 async collect(r){
  const child=new Session(this.home,{id:r.sessionId});for await(const e of child.events())if(e.type==='usage'&&!this.session.seenUsage.has(`agent:${r.id}:${e.requestId}`))await this.session.event({...e,originalRequestId:e.originalRequestId||e.requestId,sourceAt:e.sourceAt||e.at,requestId:`agent:${r.id}:${e.requestId}`});
 }
 track(r){
  const key=`${r.id}:${r.jobId}`;if(this.tracked.has(key))return this.tracked.get(key);
  let watcher,timer,reading=false,finished=false;
  const activity=async()=>{if(reading||finished||this.controller.signal.aborted)return;reading=true;try{const status=await readJSON(join(this.home,'sessions',r.sessionId,'activity.json'),null);if(status&&!finished&&!this.controller.signal.aborted)this.app.event({type:'agent_status',agent:{...r,status:'running',activity:status.activity}});}catch{}finally{reading=false;}};
  try{watcher=watch(join(this.home,'sessions',r.sessionId),(event,file)=>{if(String(file)==='activity.json'){clearTimeout(timer);timer=setTimeout(()=>void activity(),100);timer.unref();}});watcher.on('error',()=>watcher.close());}catch{}
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
 async startAutomatic(task,runId,signal){
  const c=this.app.engine.config;if(!c.overkill||c.subagentDepth>=1)return;
  const active=[];for(const r of await this.records()){const j=await this.app.jobs.get(r.jobId).catch(()=>null);if(j&&['running','queued'].includes(j.status))active.push(r);}
  const existing=await this.records();const profiles=c.agents.filter(p=>!existing.some(r=>r.profile===p.id&&r.runId===runId)&&!active.some(r=>r.profile===p.id)).slice(0,Math.max(0,c.subagentConcurrency-active.length));
  for(const spec of profiles){signal?.throwIfAborted();await this.spawn({profile:spec.id,runId,automatic:true,name:taskName(task,spec.name),prompt:`Automatic advisory task. Do not implement changes or launch builds; the parent owns implementation.\nRole: ${spec.job}\nUser task: ${task}\nInspect relevant existing evidence, identify concrete findings and propose next steps for your role. Return a concise report with file/source references. Do not duplicate another worker's role. Do not call finish; report to the parent.`,});}
 }
 async unreported(){const delivered=new Set(this.session.state.workerDeliveries||[]);return(await this.records()).filter(r=>!delivered.has(`${r.id}:${r.jobId}`));}
 async reports({wait=false,signal}={}){
  const rows=[];
  for(const r of await this.unreported()){
   const job=await this.app.jobs.get(r.jobId);if(['running','queued'].includes(job.status)&&!wait)continue;
   const result=await this.wait(r.id,signal);rows.push({key:`${r.id}:${r.jobId}`,id:r.id,name:r.name,status:result.status,summary:(result.result?.summary||result.result?.error||'No report; inspect the subagent journal.').slice(0,10000)});
  }
  return rows;
 }
 async delivered(rows){if(rows.length)await this.session.event({type:'state',state:{workerDeliveries:[...new Set([...(this.session.state.workerDeliveries||[]),...rows.map(r=>r.key)])]}});}
 async stopAll({wait=false}={}){for(const r of await this.records()){await this.app.jobs.stop(r.jobId).catch(()=>{});if(wait){await this.app.jobs.awaitCompletion(r.jobId).catch(()=>{});await this.collect(r);}}}
 async send(id,prompt){
  const r=await this.get(id),job=await this.app.jobs.get(r.jobId),dir=join(this.home,'sessions',r.sessionId);
  if(!['running','queued'].includes(job.status)){
   const active=await Promise.all((await this.records()).map(a=>this.app.jobs.get(a.jobId)));if(active.filter(j=>['running','queued'].includes(j.status)).length>=this.app.engine.config.subagentConcurrency)throw new Error('Await an existing worker before restarting this one.');
   const child=await Session.load(r.sessionId,this.home);await child.event({type:'state',state:{directories:await this.app.tools.policy.roots()}});
   const path=join(dir,'worker.json'),spec=await readJSON(path,null);spec.prompt=prompt;spec.config.agentMode=this.app.engine.config.agentMode==='plan'?'plan':spec.config.agentMode;
   await child.event({type:'state',state:{settings:{...child.state.settings,agentMode:spec.config.agentMode}}});await atomicJSON(path,spec);
   const workerArgv=[process.execPath,fileURLToPath(new URL('./agent-worker.mjs',import.meta.url)),path];
   const next=await this.app.jobs.start(shellCommand(workerArgv),this.session.meta.cwd,{label:`agent:${r.name}`,infrastructure:workerArgv,graceful_stop_ms:360000});
   const updated={...r,jobId:next.id,createdAt:new Date().toISOString()};await this.session.event({type:'state',state:{agents:(await this.records()).map(a=>a.id===id?updated:a)}});this.app.event({type:'agent_started',agent:{...updated,status:'running'}});this.track(updated);return{id,restarted:true};
  }
  const path=join(dir,'inbox.json'),inbox=await readJSON(path,[]);inbox.push({id:randomUUID(),text:prompt});await atomicJSON(path,inbox);return{queued:true,id};
 }
 register(){const tools=this.app.tools,str=Type.String();tools.add('agent','Manage configured OVERKILL subagents: list profiles/runs, spawn a bounded independent worker with its own model/session, send follow-up, status, await without model polling or stop. Workers inherit the parent directory boundary and cannot nest. Plan-mode parents force read-only children.',{action:Type.Union(['list','spawn','send','status','await','stop'].map(Type.Literal)),profile:Type.Optional(str),name:Type.Optional(Type.String({maxLength:64})),prompt:Type.Optional(str),id:Type.Optional(str)},async(a,signal)=>{
  if(a.action==='list')return{profiles:this.app.engine.config.agents,runs:await Promise.all((await this.records()).map(r=>this.status(r.id)))};
  if(a.action==='spawn'){if(!a.prompt?.trim())throw new Error('A concrete task prompt is required.');return this.spawn(a);}
  const r=await this.get(a.id);
  if(a.action==='status')return this.status(a.id);if(a.action==='await')return this.wait(a.id,signal);if(a.action==='stop'){await this.app.jobs.stop(r.jobId);return this.status(a.id);}
  if(a.action==='send'){if(!a.prompt?.trim())throw new Error('A follow-up prompt is required.');return this.send(a.id,a.prompt);}
 });}
}

export function taskName(task,role='Worker'){
 const words=cleanTerminal(redact(task||'Task')).replace(/^(?:please|can you|could you|help me|I want you to)\s+/i,'').split(/\s+/).filter(Boolean).slice(0,5).join(' ').replace(/[.,;:!?]+$/,'');
 return (words+' · '+cleanTerminal(role)).slice(0,64);
}
