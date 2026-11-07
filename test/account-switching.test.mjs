import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './helpers.mjs';
import {AccountRouter,parseQuota,exhausted,limitResetAt} from '../src/quota.mjs';
import {Session} from '../src/session.mjs';
import {App} from '../src/app.mjs';
import {defaults,loadConfig,saveConfig} from '../src/storage.mjs';

async function accounts(f,count=3){
 f.app.registry.register({...f.config.customProviders[0],keyless:false});const ids=[];
 for(let i=0;i<count;i++)ids.push(await f.app.registry.accounts.add('fixture','Account '+i,{type:'api_key',key:'key-'+i}));
 await f.app.registry.accounts.use(ids[0]);return ids;
}
const quota=(label,resetAt=Date.now()/1000+3600)=>({kind:'quota',label,usedPercent:100,resetAt});

test('automatic switching is enabled by default and current settings override old saved and pending session values',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));assert.equal(defaults.autoSwitchAccounts,true);await saveConfig({autoSwitchAccounts:true},f.app.home);
 await f.session.event({type:'state',state:{settings:{autoSwitchAccounts:false},pendingSettings:{autoSwitchAccounts:false}}});
 const restored=await Session.load(f.session.meta.id,f.app.home),app=new App(await loadConfig(f.app.home),restored,{home:f.app.home});
 assert.equal(app.engine.config.autoSwitchAccounts,true);assert.equal(app.engine.pendingSettings.autoSwitchAccounts,undefined);
 await app.engine.settings({autoSwitchAccounts:false});assert.equal(app.engine.config.autoSwitchAccounts,false);await app.close();
});

test('five-hour, weekly, model-specific and other exhausted windows skip to the next usable account without a failed model request',async t=>{
 for(const label of ['5h','7d','7d sonnet','24h','monthly']){
  const f=await fixture(t,()=>({text:'Continued on available account.'})),ids=await accounts(f);
  await f.app.accountUsage.record({id:ids[0],provider:'fixture'},{limits:[quota(label)]});await f.app.accountUsage.record({id:ids[1],provider:'fixture'},{limits:[quota('7d')]});
  await f.app.engine.run('Continue my task');assert.equal(f.requests.length,1);assert.equal(f.requestHeaders[0].authorization,'Bearer key-2');assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[2]);assert.equal(f.session.status,'idle');assert.equal(f.events.filter(e=>e.type==='account_switched').length,1);
 }
});

test('live replacement quota is checked before activating it and stale exhausted quotas can recover',async t=>{
 const f=await fixture(t,()=>({text:'Available live account.'})),ids=await accounts(f);const visited=[];
 await f.app.accountUsage.record({id:ids[2],provider:'fixture'},{limits:[quota('5h')]});
 f.app.engine.quota.refresh=async account=>{visited.push(account.id);assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[0]);return f.app.accountUsage.record(account,{limits:account.id===ids[2]?[{...quota('5h'),usedPercent:10}]:[quota(account.id===ids[0]?'5h':'7d')],replaceLimits:true});};
 await f.app.engine.run('Verify before switching');assert.deepEqual(visited,ids);assert.equal(f.requestHeaders[0].authorization,'Bearer key-2');assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[2]);
});

test('quota errors without HTTP codes rotate through accounts and preserve the same request and conversation',async t=>{
 const f=await fixture(t,()=>({text:'Verified recovered response.'})),ids=await accounts(f);const real=f.app.registry.forRequest.bind(f.app.registry);let rejected=0;
 f.app.registry.forRequest=async(provider,account)=>{const route=await real(provider,account);if(account.id!==ids[2])route.models.streamSimple=()=>({async *[Symbol.asyncIterator](){},async result(){rejected++;return{stopReason:'error',errorMessage:account.id===ids[0]?"You've hit your limit · resets later":'weekly usage_limit_reached'};}});return route;};
 await f.app.engine.run('Keep the same task');assert.equal(rejected,2);assert.equal(f.requests.length,1);assert.equal(f.requestHeaders[0].authorization,'Bearer key-2');assert.ok(f.requests[0].messages.some(m=>m.content==='Keep the same task'));assert.equal(f.session.messages.filter(m=>m.role==='user'&&!m.internal).length,1);assert.equal(f.session.status,'idle');
});

test('a task continues its next tool/model round on another account after the first account exhausts mid-task',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{call:{name:'write',args:{path:'first.txt',content:'committed'}}}:n===2?{httpError:429,message:'weekly usage limit reached'}:{text:'Finished using the saved file and evidence.'}),ids=await accounts(f,2);
 await f.app.engine.run('Write then review');assert.deepEqual(f.requestHeaders.map(h=>h.authorization),['Bearer key-0','Bearer key-0','Bearer key-1']);assert.equal(await readFile(join(f.root,'first.txt'),'utf8'),'committed');assert.ok(f.requests[2].messages.some(m=>m.role==='tool'));assert.equal(f.session.messages.filter(m=>m.role==='toolResult').length,1);assert.equal(f.session.status,'idle');assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[1]);
});

test('rate-limit exhaustion rotates accounts; expired quota windows and unlimited accounts are usable',async t=>{
 const f=await fixture(t,()=>({text:'Rate recovery.'})),ids=await accounts(f);
 await f.app.accountUsage.record({id:ids[0],provider:'fixture'},{limits:[{kind:'rate',label:'tokens',remaining:0,limit:100,reset:'2h'}]});
 await f.app.accountUsage.record({id:ids[1],provider:'fixture'},{limits:[quota('5h',Date.now()/1000-1)]});
 await f.app.engine.run('Continue after rate exhaustion');assert.equal(f.requestHeaders[0].authorization,'Bearer key-1');assert.equal(f.requests.length,1);
 const unlimited=parseQuota('anthropic',{five_hour:{unlimited:true,utilization:100},seven_day:null});assert.deepEqual(unlimited.limits,[]);
});

test('all exhausted accounts keep an autonomous task waiting and resume without restarting after capacity returns',async t=>{
 const f=await fixture(t,()=>({text:'Continued plan.'})),ids=await accounts(f,2);await f.app.update({agentMode:'plan'});
 for(const id of ids)await f.app.accountUsage.record({id,provider:'fixture'},{limits:[quota('5h'),quota('7d')]});
 const observe=f.app.options.onEvent;let resumed;
 f.app.options.onEvent=e=>{observe(e);if(e.type==='waiting'&&!resumed)resumed=f.app.accountUsage.record({id:ids[1],provider:'fixture'},{limits:[],replaceLimits:true}).then(()=>f.app.engine.wake?.());};
 await f.app.engine.run('Continue when any account can work',{loop:true});await resumed;assert.equal(f.requests.length,1);assert.equal(f.requestHeaders[0].authorization,'Bearer key-1');assert.ok(f.events.some(e=>e.type==='waiting'));assert.equal(f.session.status,'idle');
});

test('disabling switching keeps the active account; exhausted alternatives do not change selection or send requests',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),ids=await accounts(f,2);f.app.engine.config.autoSwitchAccounts=false;
 await f.app.accountUsage.record({id:ids[0],provider:'fixture'},{limits:[quota('5h')]});await assert.rejects(f.app.engine.run('Do not switch'),/eligible accounts/);assert.equal(f.requests.length,0);assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[0]);
 f.app.engine.config.autoSwitchAccounts=true;await f.app.accountUsage.record({id:ids[1],provider:'fixture'},{limits:[quota('7d')]});await assert.rejects(f.app.engine.run('All full'),/eligible accounts/);assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[0]);assert.equal(f.requests.length,0);
});

test('earliest usable account reset requires all of its exhausted windows and cooldowns to clear',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),ids=await accounts(f,2),now=Date.now(),router=new AccountRouter(f.app.registry,f.app.accountUsage,f.app.engine.config,{now:()=>now});
 await f.app.accountUsage.record({id:ids[0],provider:'fixture'},{limits:[quota('5h',(now+3600000)/1000),quota('7d',(now+86400000)/1000)]});await f.app.accountUsage.record({id:ids[1],provider:'fixture'},{limits:[quota('5h',(now+7200000)/1000)]});
 assert.equal(await router.nextReset('fixture'),now+7200000);await router.block({id:ids[1]},{seconds:10800});assert.equal(await router.nextReset('fixture'),now+10800000);
});

test('parsers retain all reported quotas, additional Codex windows and real reset formats',()=>{
 const now=Date.now(),reset=now/1000+3600;
 const anthropic=parseQuota('anthropic',{five_hour:{utilization:10,resets_at:new Date(reset*1000).toISOString()},seven_day:{utilization:20},seven_day_sonnet:{utilization:100,resets_at:new Date(reset*1000).toISOString()},seven_day_opus:{has_limit:false,utilization:100}});
 assert.deepEqual(anthropic.limits.map(l=>l.label),['5h','7d','7d sonnet']);assert.equal(exhausted(anthropic,100,now)[0].label,'7d sonnet');
 const codex=parseQuota('openai-codex',{rate_limit:{primary_window:{used_percent:100,reset_after_seconds:1800}},additional_rate_limits:[{limit_name:'Review',rate_limit:{primary_window:{used_percent:100,reset_at:String(reset)}}}]},now);
 assert.deepEqual(codex.limits.map(l=>l.label),['5h','Review 5h']);assert.equal(codex.limits[0].resetAt,now/1000+1800);assert.equal(codex.limits[1].resetAt,reset);
 assert.equal(limitResetAt({reset:'1h30m',reportedAt:new Date(now).toISOString()}),now+5400000);assert.equal(limitResetAt({reset:new Date(reset*1000).toISOString()}),reset*1000);assert.equal(limitResetAt({reset:'invalid'}),null);
 assert.equal(parseQuota('openai-codex',{rate_limit:{allowed:false,limit_reached:true,reset_after_seconds:300}},now).limits[0].usedPercent,100);
});

 test('context overflow remains a compaction error and never rotates accounts',async t=>{
 const f=await fixture(t,()=>({httpError:400,message:'maximum context window limit exceeded'})),ids=await accounts(f,2);
 await assert.rejects(f.app.engine.run('Check context classification'),/context window/);assert.equal(f.requests.length,1);assert.equal((await f.app.registry.accounts.selected('fixture')).id,ids[0]);assert.ok(!f.events.some(e=>e.type==='account_exhausted'||e.type==='account_switched'));
});
 test('usage rejection cools an account down until its longest exhausted window instead of retrying every minute',async t=>{
 const f=await fixture(t,()=>({httpError:429,message:'weekly limit reached'})),ids=await accounts(f,2),weekly=Date.now()/1000+86400;let checks=0;
 f.app.engine.quota.refresh=async(account,options)=>{if(options?.force&&account.id===ids[0]){checks++;await f.app.accountUsage.record(account,{limits:[quota('5h'),quota('7d',weekly)]});}return f.app.accountUsage.get(account.id);};
 await assert.rejects(f.app.engine.run('Exhaust both accounts'),/weekly limit/);assert.equal(checks,1);assert.equal(Date.parse((await f.app.accountUsage.get(ids[0])).cooldownUntil),Math.floor(weekly*1000));assert.equal(f.requests.length,2);
});

test('Codex and Claude Code provider routes continue on their next saved account after a usage error',async t=>{
 for(const provider of ['openai-codex','claude-code']){
  const f=await fixture(t,(_p,n)=>n===1?{httpError:429,message:"You've hit your weekly usage limit"}:{text:'Continued on replacement.'});
  f.app.registry.register({...f.config.customProviders[0],id:provider,keyless:false});f.app.engine.config.model=provider+'/test';
  const a=await f.app.registry.accounts.add(provider,'First',{type:'api_key',key:'provider-first'}),b=await f.app.registry.accounts.add(provider,'Next',{type:'api_key',key:'provider-next'});await f.app.registry.accounts.use(a);
  await f.app.engine.run('Continue the current provider task');assert.equal(f.requests.length,2);assert.deepEqual(f.requestHeaders.map(h=>h.authorization),['Bearer provider-first','Bearer provider-next']);assert.equal((await f.app.registry.accounts.selected(provider)).id,b);assert.equal(f.app.engine.config.model,provider+'/test');assert.equal(f.session.status,'idle');
 }
});

 test('absolute reset timestamps do not drift when time advances before writing a cooldown',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),ids=await accounts(f,1),start=Date.now(),until=start+86400000;let clock=start;
 const router=new AccountRouter(f.app.registry,f.app.accountUsage,f.app.engine.config,{now:()=>++clock});
 await router.block({id:ids[0]},{seconds:60,until});assert.equal(Date.parse((await f.app.accountUsage.get(ids[0])).cooldownUntil),until);
});
