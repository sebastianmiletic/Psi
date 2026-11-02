import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { atomicJSON,readJSON,withLock,alive } from './storage.mjs';
import { Session } from './session.mjs';

const count=n=>Number.isFinite(n)&&n>=0?n:0;
export const dayKey=t=>{const d=new Date(t);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
export function periodStart(period,now=Date.now()){
 const d=new Date(now);d.setHours(0,0,0,0);
 if(period==='week')d.setDate(d.getDate()-(d.getDay()+6)%7);else if(period==='month')d.setDate(1);else return 0;
 return +d;
}
export function unionTime(intervals){
 const sorted=intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);let total=0,start=null,end=null;
 for(const [a,b]of sorted){if(start===null){start=a;end=b;}else if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b;}}
 return total+(start===null?0:end-start);
}
function entry(meta,worker,info){return{createdAt:meta.createdAt,worker,ino:info.ino,offset:0,size:0,mtime:0,usage:[],counts:[],intervals:[],activeStart:null,lastAt:0};}
function consume(row,e){
 const t=Date.parse(e.sourceAt||e.at);if(!Number.isFinite(t))return;
 if(e.type==='usage'&&e.usage){const u=e.usage;
  row.usage.push({id:e.originalRequestId||e.requestId?.replace(/^(?:agent:[^:]+:)+/,''),at:t,copied:!!e.requestId?.startsWith('agent:'),sourceKnown:!!e.sourceAt,provider:e.provider||'unknown',model:e.model||null,accountId:e.accountId||'',input:count(u.input),output:count(u.output),cacheRead:count(u.cacheRead),cacheWrite:count(u.cacheWrite),tokens:Number.isFinite(u.totalTokens)?count(u.totalTokens):['input','output','cacheRead','cacheWrite'].reduce((n,k)=>n+count(u[k]),0)});
 }
 if(e.type==='message'&&e.message?.role==='toolResult')row.counts.push({at:t,kind:'tool'});
 if(e.type==='state'&&e.state?.loopStatus==='complete'&&e.state.completed)row.counts.push({at:t,kind:'goal'});
 if(e.type==='status'){
  if(e.status==='running'){if(row.activeStart===null)row.activeStart=t;}
  else if(row.activeStart!==null){const end=e.status==='interrupted'?row.lastAt:t;if(end>row.activeStart)row.intervals.push([row.activeStart,end]);row.activeStart=null;}
 }
 row.lastAt=Math.max(row.lastAt,t);
}
async function appendEvents(path,row,size){
 if(size<=row.offset)return;
 const input=createReadStream(path,{start:row.offset,end:size-1,encoding:'utf8'});let pending='';
 for await(const chunk of input){pending+=chunk;let at;
  while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);row.offset+=Buffer.byteLength(line+'\n');
   if(!line.trim())continue;try{consume(row,JSON.parse(line));}catch{row.malformed=(row.malformed||0)+1;}
  }
 }
 // An unfinished final append is deliberately left for the next read, without repairing the journal.
}
export class Statistics {
 constructor(home){this.home=home;this.path=join(home,'stats-cache.json');}
 async read({now=Date.now()}={}){
  return withLock(join(this.home,'stats.lock'),async()=>{
   const old=await readJSON(this.path,null),cache=old?.schema===1?old:{schema:1,sessions:{}};
   const entries=await Session.storageEntries(this.home),present=new Set(entries.map(e=>e.id));let changed=false;
   for(const id of Object.keys(cache.sessions))if(!present.has(id)){delete cache.sessions[id];changed=true;}
   const live={};
   for(const {id,dir,meta} of entries){
    const path=join(dir,'events.jsonl');
    const info=await stat(path).catch(()=>null);if(!info)continue;
    let row=cache.sessions[id];
    if(!row||row.ino!==info.ino||info.size<row.size||(info.size===row.size&&info.mtimeMs!==row.mtime)){
     row=entry(meta,!!meta.parentSession||!!await stat(join(dir,'worker.json')).catch(()=>null),info);cache.sessions[id]=row;changed=true;
    }
    if(info.size>row.offset){await appendEvents(path,row,info.size);row.size=info.size;row.mtime=info.mtimeMs;changed=true;}
    if(row.activeStart!==null){const lock=await readJSON(join(dir,'run.lock'),null).catch(()=>null);live[id]=!!lock?.pid&&alive(lock.pid);}
   }
   if(changed)await atomicJSON(this.path,cache);
   return ['week','month','all'].map(period=>summarize(cache.sessions,live,period,now));
  });
 }
}
export function summarize(sessions,live,period,now){
 const start=periodStart(period,now),allRequests=new Map();
 for(const [session,row]of Object.entries(sessions))for(const [i,u]of row.usage.entries()){
  const key=u.id?`${u.provider}:${u.accountId}:${u.id}`:`${session}:${i}`;
  if(!allRequests.has(key)||allRequests.get(key).copied&&!u.copied)allRequests.set(key,{...u,session,worker:row.worker});
 }
 const stats={period,start,now,input:0,output:0,cacheRead:0,cacheWrite:0,tokens:0,requests:0,tools:0,goals:0,sessions:0,workers:0,activeMs:0,agentMs:0,days:{},providers:{},firstAt:null,unknownDatedRequests:0,malformed:0};
 const activeSessions=new Set(),ranges=[];
 for(const u of allRequests.values()){
  if(u.copied&&!u.sourceKnown){stats.unknownDatedRequests++;if(period!=='all')continue;}
  if(u.at<start||u.at>now)continue;
  stats.requests++;for(const k of ['input','output','cacheRead','cacheWrite','tokens'])stats[k]+=u[k];
  activeSessions.add(u.session);
  if(!u.copied||u.sourceKnown){stats.firstAt=stats.firstAt===null?u.at:Math.min(stats.firstAt,u.at);const key=dayKey(u.at);stats.days[key]=(stats.days[key]||0)+u.tokens;}
  const p=stats.providers[u.provider]||={tokens:0,requests:0};p.tokens+=u.tokens;p.requests++;
 }
 for(const [id,row]of Object.entries(sessions)){
  stats.malformed+=row.malformed||0;
  for(const c of row.counts)if(c.at>=start&&c.at<=now){stats[c.kind==='tool'?'tools':'goals']++;activeSessions.add(id);}
  const intervals=[...row.intervals];if(row.activeStart!==null)intervals.push([row.activeStart,live[id]?now:row.lastAt]);
  for(const [a,b]of intervals){const range=[Math.max(a,start),Math.min(b,now)];if(range[1]>range[0]){ranges.push(range);stats.agentMs+=range[1]-range[0];activeSessions.add(id);}}
 }
 for(const id of activeSessions)if(sessions[id]?.worker)stats.workers++;else stats.sessions++;
 stats.activeMs=unionTime(ranges);stats.cachePercent=stats.input+stats.cacheRead+stats.cacheWrite?Math.round(stats.cacheRead/(stats.input+stats.cacheRead+stats.cacheWrite)*100):0;
 return stats;
}
export function formatDuration(ms){const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);return hours?`${hours}h ${minutes}m`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`;}
