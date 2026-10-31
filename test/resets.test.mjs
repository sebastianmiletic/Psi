import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences,visibleWidth } from '@earendil-works/pi-tui';
import { Resets,resetCredits } from '../src/resets.mjs';
import { CodexResetClient,withCodexResetClient } from '../src/codex-resets.mjs';
import { TerminalUI,commands } from '../src/ui.mjs';
import { MemoryTerminal } from './terminal.mjs';
import { fixture } from './helpers.mjs';
const account={id:'account-a',name:'Personal',provider:'openai-codex',type:'oauth',billingMode:'subscription'};
const snapshot=(count=1,used=100)=>({accountId:'remote-a',ordinaryUsageAllowed:used<100,rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:Date.now()/1000+7200},secondary:{usedPercent:25,windowDurationMins:10080,resetsAt:Date.now()/1000+5*86400}},rateLimitResetCredits:{availableCount:count,credits:count?[{id:'credit-one',status:'available',resetType:'codexRateLimits',expiresAt:Date.now()/1000+86400}]:[]}});
async function setup(t){const f=await fixture(t,()=>({text:'unused'}));f.app.registry.forAccount=()=>({getAuth:async()=>({})});f.app.registry.accounts.store=a=>({read:async()=>({access:'TEST-SECRET-TOKEN',accountId:'remote-'+a.id.slice(-1)})});f.app.engine.quota.refresh=async a=>f.app.accountUsage.get(a.id);return f;}
const screen=ui=>{ui.tui.renderNow();return ui.tui.getScreenLines().map(stripTerminalSequences);};
async function until(fn){for(let i=0;i<100&&!fn();i++)await delay(10);assert.ok(fn());}

test('Codex reset discovery pins the selected account and preserves reported credits and reset times',async t=>{
 const f=await setup(t),seen=[];const resets=new Resets(f.app,{connect:async(options,tokens,fn)=>{const auth=await tokens();assert.equal(auth.chatgptAccountId,'remote-a');seen.push(options);return fn({request:async method=>{assert.equal(method,'account/rateLimits/read');return snapshot(2,80);}});}});
 const data=await resets.read(account);assert.equal(data.credits.availableCount,2);assert.equal(data.usage.limits[0].label,'5h');assert.equal(data.usage.limits[1].label,'7d');assert.equal(data.usage.limits[0].usedPercent,80);assert.equal(seen.length,1);assert.equal(f.requests.length,0);assert.equal(resetCredits({availableCount:null}),null);assert.equal(resetCredits({availableCount:0,credits:[]}).availableCount,0);
});
test('a lost reset response retries the same persisted key and never consumes a second credit',async t=>{
 const f=await setup(t),usedKeys=new Set(),calls=[];let redeemed=false;
 await f.app.accountUsage.patch(account.id,{cooldownUntil:new Date(Date.now()+600000).toISOString(),cooldownReason:'quota'});await f.app.accountUsage.patch('account-b',{marker:'unchanged'});
 const resets=new Resets(f.app,{connect:async(options,tokens,fn)=>{await tokens();return fn({request:async(method,params)=>{
  if(method==='account/rateLimits/read')return snapshot(redeemed?0:1,redeemed?0:100);
  calls.push(params);if(usedKeys.has(params.idempotencyKey))return{outcome:'alreadyRedeemed'};usedKeys.add(params.idempotencyKey);redeemed=true;throw new Error('Connection lost after receipt');
 }});}});
 await assert.rejects(resets.consume(account),/Connection lost/);const pending=JSON.parse(await readFile(resets.path(account),'utf8'));assert.equal(pending.phase,'pending');assert.ok(pending.idempotencyKey);assert.doesNotMatch(await readFile(resets.path(account),'utf8'),/TEST-SECRET/);
 const data=await resets.read(account);assert.equal(data.pending.idempotencyKey,pending.idempotencyKey);assert.equal(data.credits.availableCount,0);
 const result=await resets.consume(account);assert.equal(result.outcome,'alreadyRedeemed');assert.equal(result.usage.limits[0].usedPercent,0);assert.equal(result.usage.cooldownUntil,null);assert.equal(calls.length,2);assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);assert.equal(usedKeys.size,1);assert.equal((await f.app.accountUsage.get('account-b')).marker,'unchanged');assert.equal(JSON.parse(await readFile(resets.path(account),'utf8')).phase,'complete');
});
test('unsupported accounts cannot redeem, zero credits do not POST, and foreign snapshots are rejected',async t=>{
 const f=await setup(t);let posts=0;
 const resets=new Resets(f.app,{connect:async(o,tokens,fn)=>{await tokens();return fn({request:async method=>{if(method.includes('consume'))posts++;return snapshot(0,70);}});}});
 await assert.rejects(resets.consume({...account,provider:'anthropic'}),/Usage page/);await assert.rejects(resets.consume(account),/No reset credits/);assert.equal(posts,0);
 const foreign=new Resets(f.app,{connect:async(o,tokens,fn)=>{await tokens();return fn({request:async()=>({...snapshot(),accountId:'remote-b'})});}});const data=await foreign.read(account);assert.match(data.error,/another account/);assert.equal(data.credits,null);
});
test('reset panel keeps the header, shows both timers, confirms redemption and cancels pending work',async t=>{
 const f=await setup(t),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();ui.editor.setText('Draft');
 let uses=0,signal;const data={account,mode:'codex',credits:{availableCount:2,credits:[]},usage:{limits:[{kind:'quota',label:'5h',usedPercent:91,resetAt:Date.now()/1000+3600},{kind:'quota',label:'7d',usedPercent:70,resetAt:Date.now()/1000+86400}]}};
 const menu=ui.resetMenu({account,read:async s=>{signal=s;return data;},use:async()=>{uses++;return {...data,outcome:'reset',credits:{availableCount:1,credits:[]}};}});await until(()=>screen(ui).some(l=>l.includes('Resets 2')));
 assert.match(screen(ui).slice(0,6).join('\n'),/Psi/);assert.match(screen(ui).join('\n'),/5h.*9%/);assert.match(screen(ui).join('\n'),/Week.*30%/);assert.match(screen(ui).join('\n'),/1h 0m/);assert.equal(ui.tui.hasOverlay(),false);
 terminal.input('\r');assert.equal(uses,0);assert.match(screen(ui).join('\n'),/confirm/);terminal.resize(28,18);assert.match(screen(ui).join('\n'),/confirm/);assert.ok(ui.tui.getScreenLines().every(l=>visibleWidth(l)<=28));terminal.input('\r');await until(()=>uses===1);terminal.input('\x1b');await menu;assert.equal(signal.aborted,true);assert.equal(ui.editor.getText(),'Draft');assert.equal(f.requests.length,0);
});
test('Claude reset panel routes to provider Usage, while API accounts show no invented reset allowance',async t=>{
 const f=await setup(t),claude={...account,provider:'anthropic'};const data=await new Resets(f.app).read(claude);assert.equal(data.mode,'claude');assert.equal(data.credits,null);
 const terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();let used=false;
 const menu=ui.resetMenu({account:claude,read:async()=>data,use:async()=>{used=true;}});await until(()=>screen(ui).some(l=>l.includes('Claude Usage')));terminal.input('o');assert.equal(await menu,'web');assert.equal(used,false);assert.ok(commands.some(c=>c.name==='reset'));
 const api=await new Resets(f.app).read({...account,type:'api_key',provider:'fixture'});assert.equal(api.mode,'none');assert.equal(api.credits,null);
});

test('Codex bridge sends credentials only after in-memory auth preflight and closes its process',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),script=join(f.root,'rpc.mjs'),trace=join(f.root,'trace.json');
 await writeFile(script,`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const methods=[];const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);methods.push(r.method);if(r.id===undefined)continue;let result={};if(r.method==='config/read')result={config:{cli_auth_credentials_store:'ephemeral',chatgpt_base_url:'https://chatgpt.com/backend-api/'}};if(r.method==='account/login/start'){if(r.params.accessToken!=='SECRET')throw new Error('wrong token');result={type:'chatgptAuthTokens'};}if(r.method==='account/rateLimits/read')result={rateLimitResetCredits:{availableCount:2}};writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),methods}));send({id:r.id,result});}`);
 const result=await withCodexResetClient({command:process.execPath,prefix:[script,trace]},async()=>({accessToken:'SECRET',chatgptAccountId:'pinned'}),c=>c.request('account/rateLimits/read'));assert.equal(result.rateLimitResetCredits.availableCount,2);
 const log=await readFile(trace,'utf8');assert.doesNotMatch(log,/SECRET/);const traceData=JSON.parse(log);assert.ok(traceData.methods.indexOf('config/read')<traceData.methods.indexOf('account/login/start'));assert.ok(traceData.args.includes('cli_auth_credentials_store="ephemeral"'));
 const missing=new CodexResetClient({command:join(f.root,'missing-codex')});try{await assert.rejects(missing.initialize(),/Install or update/);}finally{await missing.close();}
});
