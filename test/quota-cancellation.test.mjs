import test from 'node:test';
import assert from 'node:assert/strict';
import {QuotaMonitor} from '../src/quota.mjs';
import {fixture} from './helpers.mjs';
const account={id:'shared-quota-fixture',type:'oauth',provider:'openai-codex'};
const registry={forAccount:()=>({getAuth:async()=>({})}),accounts:{store:()=>({read:async()=>({access:'fixture-access',accountId:'fixture'})})}};
const response=()=>new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:10,reset_after_seconds:3600}}}));

test('cancelling a shared UI quota poll does not cancel inference preparing its next request',async t=>{
 const f=await fixture(t,()=>({text:'Inference survived the UI poll cancellation.'})),id=await f.app.registry.accounts.add('fixture','Current',{type:'api_key',key:'fixture-key'}),shared={...account,id};let ready,calls=0;
 const started=new Promise(r=>ready=r),pollController=new AbortController();
 const monitor=new QuotaMonitor(registry,f.config,f.app.home,{fetchImpl:async(_url,{signal})=>{calls++;if(calls===1){ready();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return response();}});
 const poll=monitor.refresh(shared,{signal:pollController.signal});void poll.catch(()=>{});await started;
 let joined;const inferenceJoined=new Promise(r=>joined=r);
 f.app.engine.quota.refresh=(_account,options)=>{joined();return monitor.refresh(shared,options);};const run=f.app.engine.run('Keep the current task');
 await inferenceJoined;pollController.abort(new DOMException('UI poll replaced','AbortError'));await assert.rejects(poll,/UI poll replaced/);await run;
 assert.equal(calls,2);assert.equal(f.requests.length,1);assert.equal(f.session.status,'idle');assert.ok(!f.events.some(e=>e.type==='error'||e.type==='stopped'));
});

test('a cancelled quota waiter detaches immediately without aborting the live poll owner',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let ready,release,calls=0;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r),controller=new AbortController();
 const monitor=new QuotaMonitor(registry,f.config,f.app.home,{fetchImpl:async()=>{calls++;ready();await gate;return response();}});
 const poll=monitor.refresh(account);await started;const waiter=monitor.refresh(account,{signal:controller.signal});controller.abort(new Error('Stopped by user'));await assert.rejects(waiter,/Stopped by user/);assert.equal(calls,1);release();assert.equal((await poll).limits[0].usedPercent,10);assert.equal(monitor.pending.size,0);
});
