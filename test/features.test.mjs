import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { parseQuota, QuotaMonitor, AccountRouter } from '../src/quota.mjs';
import { AccountUsage, usageLabel } from '../src/usage.mjs';
import { Session } from '../src/session.mjs';
import { defaults, loadConfig } from '../src/storage.mjs';
import { TerminalUI } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { renderPsi } from '../src/logo.mjs';

const finish=()=>({call:{name:'finish',args:{summary:'Goal achieved.',report:'Goal achieved. Evidence saved and verified.',evidence:['evidence.txt']}}});
test('goal loop survives plain final answers and temporary failures until evidence-backed completion',async t=>{
  const f=await fixture(t,(_p,n)=>n===1?{httpError:503}:n<6?{text:'Still working.'}:n===6?{call:{name:'write',args:{path:'evidence.txt',content:'verified'}}}:finish());
  f.app.engine.config.retries=0;f.app.engine.config.loopRetrySeconds=0.05;
  await f.app.engine.run('Produce verified evidence.',{loop:true});
  assert.equal(f.session.state.loopStatus,'complete');assert.equal(f.session.state.loopGoal,null);
  assert.equal(f.requests.length,7);assert.ok(f.events.some(e=>e.type==='waiting'));
});
test('a user stop ends a waiting loop while preserving the unfinished goal for resume',async t=>{
  const f=await fixture(t,()=>({httpError:503}));f.app.engine.config.retries=0;
  const notify=f.app.options.onEvent;f.app.options.onEvent=e=>{notify(e);if(e.type==='waiting')setTimeout(()=>f.app.engine.stop(),10);};
  await f.app.engine.run('Unfinished objective',{loop:true});
  assert.equal(f.session.status,'stopped');assert.equal(f.session.state.loopGoal,'Unfinished objective');
  const restored=await Session.load(f.session.meta.id,f.session.home);assert.equal(restored.state.loopStatus,'stopped');
});
test('changing a budget while a loop waits wakes it without dropping the goal',async t=>{
  const f=await fixture(t,()=>finish());await writeFile(join(f.root,'evidence.txt'),'ok');f.app.engine.config.budget=0.0000001;
  const notify=f.app.options.onEvent;f.app.options.onEvent=e=>{notify(e);if(e.type==='waiting')setTimeout(()=>void f.app.engine.settings({budget:0}),10);};
  await f.app.engine.run('Finish after the configured budget changes',{loop:true});assert.equal(f.session.state.loopStatus,'complete');assert.equal(f.requests.length,1);
});
test('finish refuses nonexistent evidence and the loop continues to a verified artifact',async t=>{
  const f=await fixture(t,(_p,n)=>n===1?finish():n===2?{call:{name:'write',args:{path:'evidence.txt',content:'actual'}}}:finish());
  await f.app.engine.run('Create actual evidence',{loop:true});assert.equal(f.requests.length,3);
  assert.equal(f.session.messages.filter(m=>m.role==='toolResult')[0].isError,true);
});
test('automatic failover uses the next same-provider account after a quota error',async t=>{
  const f=await fixture(t,(_p,n)=>n===1?{httpError:429,message:'usage limit reached'}:{text:'Recovered'});
  f.app.registry.register({...f.config.customProviders[0],keyless:false});const a=f.app.registry.accounts;
  const first=await a.add('fixture','First',{type:'api_key',key:'first-key'});const second=await a.add('fixture','Second',{type:'api_key',key:'second-key'});await a.use(first);
  f.app.engine.config.autoSwitchAccounts=true;await f.app.engine.run('Continue');
  assert.equal(f.requestHeaders[0].authorization,'Bearer first-key');assert.equal(f.requestHeaders[1].authorization,'Bearer second-key');assert.equal((await a.selected('fixture')).id,second);
});
test('cross-provider failover is limited to explicitly configured models',async t=>{
  const f=await fixture(t,(_p,n)=>n===1?{httpError:429,message:'quota exhausted'}:{text:'Fallback succeeded'});
  f.app.registry.register({...f.config.customProviders[0],keyless:false});f.app.registry.register({...f.config.customProviders[0],id:'alternate',keyless:false});
  await f.app.registry.accounts.add('fixture','A',{type:'api_key',key:'a-key'});await f.app.registry.accounts.add('alternate','B',{type:'api_key',key:'b-key'});
  f.app.engine.config.autoSwitchAccounts=true;f.app.engine.config.fallbackModels=['alternate/test'];
  await f.app.engine.run('Use only approved routes');assert.equal(f.app.engine.config.model,'alternate/test');assert.equal(f.requestHeaders[1].authorization,'Bearer b-key');
});
test('provider-reported billed USD is used for the session cost when supplied',async t=>{
  const f=await fixture(t,()=>({text:'Metered',billedCost:0.012345}));await f.app.engine.run('Check metered cost');
  assert.equal(f.session.meteredCost,0.012345);assert.equal(f.session.meteredCostKnown,true);
  const restored=await Session.load(f.session.meta.id,f.session.home);assert.equal(restored.meteredCost,0.012345);
});
test('quota windows omit absent/unlimited plans and parse real five-hour/weekly schemas',()=>{
  assert.deepEqual(parseQuota('anthropic',{five_hour:null,seven_day:null}).limits,[]);
  const a=parseQuota('anthropic',{five_hour:{utilization:12.5,resets_at:'2099-01-01T00:00:00Z'},seven_day:{utilization:34,resets_at:'2099-01-07T00:00:00Z'}});
  assert.equal(a.limits[0].label,'5h');assert.equal(a.limits[1].usedPercent,34);
  const b=parseQuota('openai-codex',{rate_limit:{primary_window:{used_percent:31,limit_window_seconds:18000,reset_at:9999999999},secondary_window:{used_percent:42,limit_window_seconds:604800,reset_at:9999999999}}});assert.equal(b.limits[1].label,'7d');
  assert.deepEqual(parseQuota('openai-codex',{rate_limit:{primary_window:{used_percent:0,limit_window_seconds:0}}}).limits,[]);
  assert.equal(usageLabel({name:'Unlimited',type:'oauth'},{}),'Unlimited');
});
test('quota refresh is cached, account-specific, and backs off after HTTP 429',async t=>{
  const f=await fixture(t,()=>({text:'Unused'}));let calls=0,clock=Date.now();const account={id:'quota-account',provider:'anthropic',type:'oauth'};
  const registry={forAccount:()=>({getAuth:async()=>({auth:{apiKey:'access'}})}),accounts:{store:()=>({read:async()=>({access:'test-access'})})}};
  const monitor=new QuotaMonitor(registry,defaults,f.session.home,{now:()=>clock,fetchImpl:async(_url,opts)=>{calls++;assert.equal(opts.headers.Authorization,'Bearer test-access');return calls===1?new Response(JSON.stringify({five_hour:{utilization:20,resets_at:'2099-01-01T00:00:00Z'},seven_day:null})):new Response('',{status:429,headers:{'retry-after':'300'}});}});
  assert.equal((await monitor.refresh(account)).limits.length,1);await monitor.refresh(account);assert.equal(calls,1);
  clock+=130000;await monitor.refresh(account);await monitor.refresh(account,{force:true});assert.equal(calls,2);
  assert.doesNotMatch(await readFile(monitor.usage.path,'utf8'),/test-access|Authorization/);
});
test('settings UI persists colours, automatic switching and token limits; logo colour updates without a restart',async t=>{
  const f=await fixture(t,()=>({text:'Unused'}));const answers=['accent','violet','autoSwitchAccounts','maxOutputTokens',null];
  f.app.ui={choose:async()=>answers.shift(),ask:async()=> '2048',note:()=>{},render:()=>{},event:()=>{},stop:()=>{}};
  await f.app.settingsMenu();const c=await loadConfig(f.session.home);assert.equal(c.accent,'violet');assert.equal(c.autoSwitchAccounts,true);assert.equal(c.maxOutputTokens,2048);
  assert.notDeepEqual(renderPsi(12,4,0,false,'sage'),renderPsi(12,4,0,false,'violet'));
});
test('/loop without an argument asks for the objective before starting',async t=>{
  const f=await fixture(t,()=>({text:'Unused'}));let seen;
  f.app.ui={ask:async()=> 'Verify my goal',user:()=>{},stop:()=>{}};f.app.engine.run=async(text,options)=>{seen={text,options};};
  await f.app.submit('/loop');assert.deepEqual(seen,{text:'Verify my goal',options:{loop:true}});
});
test('event-driven job waiting completes without model polling',async t=>{
  const f=await fixture(t,()=>({text:'Unused'}));const job=await f.app.jobs.start("sleep 0.1; printf 'done'",f.root);
  const result=await f.app.jobs.awaitCompletion(job.id);assert.equal(result.status,'completed');assert.equal(f.requests.length,0);
});

test('settings can change during a running goal: appearance updates now, model controls at the next boundary',async t=>{
  const f=await fixture(t,(_p,n)=>n===1?{call:{name:'write',args:{path:'evidence.txt',content:'ok'}}}:finish());
  let update;const notify=f.app.options.onEvent;
  f.app.options.onEvent=e=>{notify(e);if(e.type==='request_start'&&!update)update=Promise.all([f.app.engine.settings({accent:'rose'}),f.app.engine.settings({maxOutputTokens:1024})]);};
  await f.app.engine.run('Write and verify evidence',{loop:true});await update;
  assert.equal(f.app.engine.config.accent,'rose');assert.equal(f.app.engine.config.maxOutputTokens,1024);
  assert.deepEqual(f.app.engine.pendingSettings,{});assert.ok(f.events.some(e=>e.type==='settings_queued'));
  const restored=await Session.load(f.session.meta.id,f.session.home);assert.equal(restored.state.settings.maxOutputTokens,1024);
});

test('an exhausted account keeps a goal waiting without sending inference calls, even with automatic switching off',async t=>{
  const f=await fixture(t,()=>({text:'must not be called'}));
  const id=await f.app.registry.accounts.add('fixture','Waiting',{type:'api_key',key:'test-key'});
  await f.app.accountUsage.patch(id,{limits:[{kind:'quota',label:'5h',usedPercent:100,resetAt:9999999999}]});
  const notify=f.app.options.onEvent;f.app.options.onEvent=e=>{notify(e);if(e.type==='waiting')setTimeout(()=>f.app.engine.stop(),5);};
  await f.app.engine.run('Wait until the account is usable',{loop:true});
  assert.equal(f.requests.length,0);assert.equal(f.session.state.loopGoal,'Wait until the account is usable');assert.equal(f.session.status,'stopped');
});
