import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJSON,withLock,alive } from './storage.mjs';
import {journalInfo,journalLines} from './journal.mjs';
import {readPackedJSON,writePackedJSON} from './packed-json.mjs';
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
function entry(meta,worker,info){return{createdAt:meta.createdAt,parentSession:meta.parentSession,worker,humanRanges:[],humanKnown:false,humanOpen:false,ino:info.ino,offset:0,size:0,mtime:0,usage:[],counts:[],intervals:[],activeStart:null,lastAt:0};}
function humanPulse(row,t){const last=row.humanRanges.at(-1);if(last&&t<=last[1])last[1]=Math.max(last[1],t+60000);else row.humanRanges.push([t,t+60000]);}
function consume(row,e){
 const t=Date.parse(e.sourceAt||e.at);if(!Number.isFinite(t))return;
 if(e.type==='usage'&&e.usage){const u=e.usage;
  row.usage.push({id:e.originalRequestId||e.requestId?.replace(/^(?:agent:[^:]+:)+/,''),at:t,copied:!!e.requestId?.startsWith('agent:'),sourceKnown:!!e.sourceAt,provider:e.provider||'unknown',model:e.model||null,accountId:e.accountId||'',input:count(u.input),output:count(u.output),cacheRead:count(u.cacheRead),cacheWrite:count(u.cacheWrite),tokens:Number.isFinite(u.totalTokens)?count(u.totalTokens):['input','output','cacheRead','cacheWrite'].reduce((n,k)=>n+count(u[k]),0)});
 }
 if(e.type==='ui_activity'){
  row.humanKnown=true;
  if(['input','focus'].includes(e.kind)){humanPulse(row,t);row.humanOpen=true;}
  else if(['blur','closed'].includes(e.kind)){const last=row.humanRanges.at(-1);if(last)last[1]=Math.min(last[1],t);row.humanOpen=false;}
 }
 if(e.type==='message'&&e.message?.role==='user'&&!e.message.internal)row.counts.push({at:t,kind:'message'});
 if(e.type==='message'&&e.message?.role==='toolResult')row.counts.push({at:t,kind:'tool'});
 if(e.type==='state'&&e.state?.loopStatus==='complete'&&e.state.completed)row.counts.push({at:t,kind:'goal'});
 if(e.type==='status'){
  if(e.status==='running'){if(row.activeStart===null)row.activeStart=t;}
  else if(row.activeStart!==null){const end=e.status==='interrupted'?row.lastAt:t;if(end>row.activeStart)row.intervals.push([row.activeStart,end]);row.activeStart=null;}
 }
 row.lastAt=Math.max(row.lastAt,t);
}
async function appendEvents(dir,row){
 for await(const {line,offset} of journalLines(dir,{offset:row.offset})){
  row.offset=offset;if(!line.trim())continue;
  try{consume(row,JSON.parse(line));}catch{row.malformed=(row.malformed||0)+1;}
 }
}
export class Statistics {
 constructor(home){this.home=home;this.path=join(home,'stats-cache.json');}
 async read({now=Date.now(),sessionId}={}){
  return withLock(join(this.home,'stats.lock'),async()=>{
   const old=await readPackedJSON(this.path,null),cache=old?.schema===2?old:{schema:2,sessions:{}};
   const entries=await Session.storageEntries(this.home),present=new Set(entries.map(e=>e.id));let changed=false;
   for(const id of Object.keys(cache.sessions))if(!present.has(id)){delete cache.sessions[id];changed=true;}
   const live={},humanLive={};
   for(const {id,dir,meta} of entries){
    const info=await journalInfo(dir);if(!info.size)continue;
    let row=cache.sessions[id];
    if(!row||row.ino!==info.ino||info.size<row.size||(info.size===row.size&&info.mtimeMs!==row.mtime)){
     row=entry(meta,!!meta.parentSession||!!await stat(join(dir,'worker.json')).catch(()=>null),info);cache.sessions[id]=row;changed=true;
    }
    if(info.size>row.offset){await appendEvents(dir,row);row.size=info.size;row.mtime=info.mtimeMs;changed=true;}
    row.parentSession=meta.parentSession;
    if(row.humanOpen){const lock=await readJSON(join(dir,'ui.lock'),null).catch(()=>null);humanLive[id]=!!lock?.pid&&alive(lock.pid);}
    if(row.activeStart!==null){const lock=await readJSON(join(dir,'run.lock'),null).catch(()=>null);live[id]=!!lock?.pid&&alive(lock.pid);}
   }
   if(changed)await writePackedJSON(this.path,cache);
   const result=['week','month','all'].map(period=>summarize(cache.sessions,live,period,now,undefined,humanLive));
   if(sessionId){const family=new Set([sessionId,...Object.entries(cache.sessions).filter(([,row])=>row.parentSession===sessionId).map(([id])=>id)]);const current=summarize(cache.sessions,live,'session',now,family,humanLive);const created=Date.parse(cache.sessions[sessionId]?.createdAt||'');current.ageMs=Number.isFinite(created)?Math.max(0,now-created):0;result.push(current);}
   return result;
  });
 }
}
export function summarize(sessions,live,period,now,family,humanLive={}){
 const start=periodStart(period,now),allRequests=new Map(),familyKeys=new Set();
 for(const [session,row]of Object.entries(sessions))for(const [i,u]of row.usage.entries()){
  const key=u.id?`${u.provider}:${u.accountId}:${u.id}`:`${session}:${i}`;
  if(family?.has(session))familyKeys.add(key);
  if(!allRequests.has(key)||allRequests.get(key).copied&&!u.copied)allRequests.set(key,{...u,session,worker:row.worker});
 }
 const stats={period,start,now,input:0,output:0,cacheRead:0,cacheWrite:0,tokens:0,requests:0,tools:0,goals:0,sessions:0,workers:0,activeMs:0,agentMs:0,days:{},providers:{},firstAt:null,unknownDatedRequests:0,malformed:0};
 const activeSessions=new Set(),ranges=[],human=[];let humanKnown=false;stats.messages=0;
 for(const [requestKey,u] of allRequests){
  if(family&&!familyKeys.has(requestKey))continue;
  if(u.copied&&!u.sourceKnown){stats.unknownDatedRequests++;if(!['all','session'].includes(period))continue;}
  if(u.at<start||u.at>now)continue;
  stats.requests++;for(const k of ['input','output','cacheRead','cacheWrite','tokens'])stats[k]+=u[k];
  activeSessions.add(u.session);
  if(!u.copied||u.sourceKnown){stats.firstAt=stats.firstAt===null?u.at:Math.min(stats.firstAt,u.at);const key=dayKey(u.at);stats.days[key]=(stats.days[key]||0)+u.tokens;}
  const p=stats.providers[u.provider]||={tokens:0,requests:0};p.tokens+=u.tokens;p.requests++;
 }
 for(const [id,row]of Object.entries(sessions)){
  if(family&&!family.has(id))continue;
  if(!row.worker&&row.humanKnown){humanKnown=true;for(const [a,b]of row.humanRanges){const range=[Math.max(a,start),Math.min(b,now,humanLive[id]?now:row.lastAt)];if(range[1]>range[0])human.push(range);}}
  stats.malformed+=row.malformed||0;
  for(const c of row.counts)if(c.at>=start&&c.at<=now){stats[c.kind==='tool'?'tools':c.kind==='message'?'messages':'goals']++;activeSessions.add(id);}
  const intervals=[...row.intervals];if(row.activeStart!==null)intervals.push([row.activeStart,live[id]?now:row.lastAt]);
  for(const [a,b]of intervals){const range=[Math.max(a,start),Math.min(b,now)];if(range[1]>range[0]){ranges.push(range);stats.agentMs+=range[1]-range[0];activeSessions.add(id);}}
 }
 for(const id of activeSessions)if(sessions[id]?.worker)stats.workers++;else stats.sessions++;
 stats.activeMs=unionTime(ranges);stats.humanMs=humanKnown?unionTime(human):null;stats.cachePercent=stats.input+stats.cacheRead+stats.cacheWrite?Math.round(stats.cacheRead/(stats.input+stats.cacheRead+stats.cacheWrite)*100):0;
 return stats;
}
export function formatDuration(ms){const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);return hours?`${hours}h ${minutes}m`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`;}
