import { Type } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Session } from './session.mjs';
import { atomicJSON,readJSON } from './storage.mjs';
import { shellCommand } from './battlecode.mjs';
export class Agents {
 constructor(app){this.app=app;this.home=app.home;this.session=app.session;}
 async records(){return this.session.state.agents||[];}
 async spawn({profile,prompt}){
  const a=this.app,c=a.engine.config;if(!c.overkill)throw new Error('Enable OVERKILL with Tab inside /effort first.');if(c.subagentDepth>=1)throw new Error('Subagents cannot create nested subagents.');
  const spec=c.agents.find(p=>p.id===profile);if(!spec)throw new Error('Unknown agent profile. Configure workers in /agents or /settings.');
  const active=[];for(const r of await this.records()){const j=await a.jobs.get(r.jobId).catch(()=>null);if(j&&['running','queued'].includes(j.status))active.push(r);}
  if(active.length>=c.subagentConcurrency)throw new Error(`All ${c.subagentConcurrency} subagent slots are occupied. Await a worker first.`);
  const child=await Session.create(a.session.meta.cwd,this.home),id=randomUUID(),manifest=join(child.dir,'worker.json');
  await child.event({type:'state',state:{directories:await a.tools.policy.roots()}});
  const model=spec.model||c.model;a.registry.find(model);
  const remaining=c.budget>0?Math.max(0,c.budget-a.session.totals.cost):0;if(c.budget>0&&remaining===0)throw new Error('The parent budget is exhausted.');
  const cap=Math.min(spec.budget>0?spec.budget:Infinity,remaining?remaining/c.subagentConcurrency:Infinity);
  const config={...c,model,effort:spec.effort||c.effort,agentMode:c.agentMode==='plan'?'plan':spec.mode||'execute',subagentDepth:(c.subagentDepth||0)+1,overkill:false,maxSteps:spec.maxSteps||80,budget:Number.isFinite(cap)?cap:0};
  await atomicJSON(manifest,{parentSession:a.session.meta.id,sessionId:child.meta.id,home:this.home,config,prompt:`Assigned role: ${spec.name}\n${spec.job}\n\nTask from parent:\n${prompt}\n\nStay within the inherited directories and assigned files. Report concrete evidence and limitations. Do not release or activate a bot unless this specific task explicitly requests it.`});
  const workerArgv=[process.execPath,fileURLToPath(new URL('./agent-worker.mjs',import.meta.url)),manifest];
  const job=await a.jobs.start(shellCommand(workerArgv),a.session.meta.cwd,{label:`agent:${spec.name}`,infrastructure:workerArgv,graceful_stop_ms:360000});
  const record={id,profile,name:spec.name,prompt,model,sessionId:child.meta.id,jobId:job.id,createdAt:new Date().toISOString()};await a.session.event({type:'state',state:{agents:[...await this.records(),record]}});a.event({type:'agent_started',agent:record});return record;
 }
 async get(id){const r=(await this.records()).find(r=>r.id===id);if(!r)throw new Error('Unknown subagent ID.');return r;}
 async status(id){const r=await this.get(id),job=await this.app.jobs.get(r.jobId),result=await readJSON(join(this.home,'sessions',r.sessionId,'worker-result.json'),null);return{...r,status:job.status,result};}
 async collect(r){
  const child=new Session(this.home,{id:r.sessionId});for await(const e of child.events())if(e.type==='usage')await this.session.event({...e,requestId:`agent:${r.id}:${e.requestId}`});
 }
 async wait(id,signal){const r=await this.get(id);await this.app.jobs.awaitCompletion(r.jobId,signal);await this.collect(r);const result=await this.status(id);this.app.event({type:'agent_finished',agent:result});return result;}
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
   await this.session.event({type:'state',state:{agents:(await this.records()).map(a=>a.id===id?{...a,jobId:next.id}:a)}});return{id,restarted:true};
  }
  const path=join(dir,'inbox.json'),inbox=await readJSON(path,[]);inbox.push({id:randomUUID(),text:prompt});await atomicJSON(path,inbox);return{queued:true,id};
 }
 register(){const tools=this.app.tools,str=Type.String();tools.add('agent','Manage configured OVERKILL subagents: list profiles/runs, spawn a bounded independent worker with its own model/session, send follow-up, status, await without model polling or stop. Workers inherit the parent directory boundary and cannot nest. Plan-mode parents force read-only children.',{action:Type.Union(['list','spawn','send','status','await','stop'].map(Type.Literal)),profile:Type.Optional(str),prompt:Type.Optional(str),id:Type.Optional(str)},async(a,signal)=>{
  if(a.action==='list')return{profiles:this.app.engine.config.agents,runs:await Promise.all((await this.records()).map(r=>this.status(r.id)))};
  if(a.action==='spawn'){if(!a.prompt?.trim())throw new Error('A concrete task prompt is required.');return this.spawn(a);}
  const r=await this.get(a.id);
  if(a.action==='status')return this.status(a.id);if(a.action==='await')return this.wait(a.id,signal);if(a.action==='stop'){await this.app.jobs.stop(r.jobId);return this.status(a.id);}
  if(a.action==='send'){if(!a.prompt?.trim())throw new Error('A follow-up prompt is required.');return this.send(a.id,a.prompt);}
 });}
}
