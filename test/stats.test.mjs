import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,appendFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Statistics,periodStart } from '../src/stats.mjs';
import { fixture } from './helpers.mjs';
const at=(month,day,hour=12,minute=0)=>+new Date(2026,month-1,day,hour,minute);
const event=(type,t,extra)=>({type,at:new Date(t).toISOString(),...extra});
const usage=(id,t,tokens,extra={})=>event('usage',t,{requestId:id,provider:'openai-codex',accountId:'test',usage:{input:tokens/2,output:tokens/4,cacheRead:tokens/4,cacheWrite:0,totalTokens:tokens},...extra});
async function journal(home,id,rows,{worker=false}={}){const dir=join(home,'sessions',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'meta.json'),JSON.stringify({id,cwd:'/test',createdAt:new Date(at(9,1)).toISOString()}));if(worker)await writeFile(join(dir,'worker.json'),'{}');await writeFile(join(dir,'events.jsonl'),rows.map(e=>JSON.stringify(e)+'\n').join(''));return join(dir,'events.jsonl');}

test('calendar periods, token categories and parallel work time avoid duplicate worker receipts',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home,start=at(10,31,9),now=at(10,31,12);
 await journal(home,'parent',[
  usage('old',at(9,30),100),usage('earlier-month',at(10,20),200),usage('this-week',at(10,31),300),
  event('status',start,{status:'running'}),event('status',start+30*60000,{status:'waiting'}),event('status',start+40*60000,{status:'running'}),event('status',start+60*60000,{status:'idle'}),
  usage('agent:worker-id:child',at(10,31),400),event('message',start,{message:{role:'toolResult',toolCallId:'read',content:[{type:'text',text:'TOP-SECRET-PROMPT'}]}})
 ]);
 await journal(home,'child',[event('status',start+5*60000,{status:'running'}),usage('child',at(10,31),400),event('status',start+45*60000,{status:'idle'})],{worker:true});
 const stats=new Statistics(home),[week,month,all]=await stats.read({now});assert.equal(week.tokens,700);assert.equal(month.tokens,900);assert.equal(all.tokens,1000);assert.equal(all.requests,4);assert.equal(all.cacheRead,250);assert.equal(all.tools,1);assert.equal(week.activeMs,60*60000);assert.equal(week.agentMs,90*60000);assert.equal(week.workers,1);assert.equal(week.sessions,1);
 assert.equal(new Date(periodStart('week',now)).getDay(),1);assert.equal(new Date(periodStart('month',now)).getDate(),1);
 const again=await stats.read({now});assert.deepEqual(again,[week,month,all]);assert.doesNotMatch(await readFile(join(home,'stats-cache.json'),'utf8'),/TOP-SECRET-PROMPT/);
});
test('incremental stats leave partial appends untouched and process completed receipts once',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home,now=at(10,31,15),path=await journal(home,'incremental',[usage('one',at(10,31),100)]),stats=new Statistics(home);
 assert.equal((await stats.read({now}))[2].tokens,100);const line=JSON.stringify(usage('two',at(10,31),200));await appendFile(path,line.slice(0,40));const partial=await readFile(path,'utf8');assert.equal((await stats.read({now}))[2].tokens,100);assert.equal(await readFile(path,'utf8'),partial);await appendFile(path,line.slice(40)+'\n');assert.equal((await stats.read({now}))[2].tokens,300);assert.equal((await stats.read({now}))[2].tokens,300);
});
test('interrupted historical runs stop at last observed activity, not the later resume time',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home,start=at(10,30,9);
 await journal(home,'interrupted',[event('status',start,{status:'running'}),usage('last',start+120000,100),event('status',at(10,31,9),{status:'interrupted'})]);const all=(await new Statistics(home).read({now:at(10,31,12)}))[2];assert.equal(all.activeMs,120000);
});
test('copied receipts retain source dates; undated legacy copies count only toward all time',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home;
 await journal(home,'copied',[usage('agent:w:known',at(10,31),100,{originalRequestId:'known',sourceAt:new Date(at(9,30)).toISOString()}),usage('agent:w:unknown',at(10,31),200)]);
 const [week,month,all]=await new Statistics(home).read({now:at(10,31,15)});assert.equal(week.tokens,0);assert.equal(month.tokens,0);assert.equal(all.tokens,300);assert.equal(all.unknownDatedRequests,1);
});
test('live run locks extend observed work across period boundaries and truncated journals rebuild totals',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.session.home,now=at(10,31,15),start=at(9,30,23),dir=join(home,'sessions','live');
 const path=await journal(home,'live',[event('status',start,{status:'running'}),usage('live-request',at(10,31,14),500)]);
 await writeFile(join(dir,'run.lock'),JSON.stringify({pid:process.pid}));const stats=new Statistics(home),[week,month,all]=await stats.read({now});
 assert.equal(all.activeMs,now-start);assert.equal(week.activeMs,now-periodStart('week',now));assert.equal(month.activeMs,now-periodStart('month',now));
 await writeFile(path,JSON.stringify(usage('replacement',at(10,31,14),30))+'\n');const rebuilt=(await stats.read({now}))[2];assert.equal(rebuilt.tokens,30);assert.equal(rebuilt.requests,1);assert.equal(rebuilt.activeMs,0);
});
