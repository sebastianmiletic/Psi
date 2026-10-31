import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { AccountUsage } from './usage.mjs';
import { atomicJSON,readJSON,withLock } from './storage.mjs';
import { parseQuota } from './quota.mjs';
import { withCodexResetClient } from './codex-resets.mjs';

const codex=a=>a?.type==='oauth'&&['openai-codex','openai'].includes(a.provider);
export function resetCredits(raw){
 if(!raw||!Number.isSafeInteger(raw.availableCount)||raw.availableCount<0)return null;
 return {availableCount:raw.availableCount,credits:Array.isArray(raw.credits)?raw.credits.slice(0,100).filter(c=>typeof c.id==='string'&&c.id.length<=512).map(c=>({id:c.id,status:c.status,resetType:c.resetType,expiresAt:Number.isFinite(c.expiresAt)&&c.expiresAt>0?c.expiresAt:null})):null};
}
export class Resets {
 constructor(app,{connect=withCodexResetClient}={}){this.app=app;this.home=app.home;this.usage=new AccountUsage(this.home);this.connect=connect;}
 path(account){return join(this.home,'resets',createHash('sha256').update(`${account.provider}:${account.id}`).digest('hex')+'.json');}
 async tokens(account){
  try{
  await this.app.registry.forAccount(account).getAuth(account.provider);
  const credential=await this.app.registry.accounts.store(account).read(account.provider);
  let id=credential?.accountId;
  if(!id&&credential?.access)try{id=JSON.parse(Buffer.from(credential.access.split('.')[1],'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id;}catch{/* Auth validation remains with the provider. */}
  if(!credential?.access||!id)throw new Error('Reconnect this account to read reset credits');
  return {accessToken:credential.access,chatgptAccountId:id};
  }catch{throw new Error('Reconnect this account to read reset credits');}
 }
 async client(account,signal,fn){
  const initial=await this.tokens(account),tokens=async()=>{const next=await this.tokens(account);if(next.chatgptAccountId!==initial.chatgptAccountId)throw new Error('Account identity changed');return next;};
  return this.connect({command:this.app.engine.config.codexCli||'codex',signal},tokens,c=>fn(c,initial.chatgptAccountId));
 }
 async snapshot(account,client,remoteId){
  const result=await client.request('account/rateLimits/read');
  if(result?.accountId&&result.accountId!==remoteId)throw new Error('Reset snapshot belongs to another account');
  const raw=result?.rateLimitsByLimitId?.codex||result?.rateLimits;
  let usage=await this.usage.get(account.id);
  if(raw&&typeof raw==='object'){const {limits}=parseQuota(account.provider,raw);usage=await this.usage.record(account,{limits,replaceLimits:true});}
  const credits=resetCredits(result?.rateLimitResetCredits);
  usage=await this.usage.patch(account.id,{resetCredits:credits,resetsCheckedAt:new Date().toISOString(),...(raw?{quotaCheckedAt:new Date().toISOString(),quotaError:null,quotaRetryAt:null}:{})});
  return {account,usage,credits,mode:'codex',ordinaryUsageAllowed:result?.ordinaryUsageAllowed===true};
 }
 async read(account,{signal}={}){
  const intent=await readJSON(this.path(account),null),pending=intent?.phase==='pending'?intent:null;
  if(codex(account))try{return {...await this.client(account,signal,(c,id)=>this.snapshot(account,c,id)),pending};}
  catch(e){if(signal?.aborted)throw e;const usage=await this.app.engine.quota.refresh(account,{force:true,signal});return {account,usage,credits:null,mode:'codex',pending,error:e.message};}
  const usage=await this.app.engine.quota.refresh(account,{force:true,signal});
  return {account,usage,credits:null,pending:null,mode:account?.type==='oauth'&&account.provider==='anthropic'?'claude':'none'};
 }
 async consume(account,{signal}={}){
  if(!codex(account))throw new Error('Use this provider’s Usage page to redeem resets');
  return withLock(this.path(account)+'.lock',async()=>this.client(account,signal,async(client,remoteId)=>{
   let intent=await readJSON(this.path(account),null);
   if(intent?.phase!=='pending'){
    const current=await this.snapshot(account,client,remoteId);
    if(!current.credits||current.credits.availableCount<1)throw new Error('No reset credits reported');
    const first=(current.credits.credits||[]).filter(c=>c.status==='available'&&c.resetType==='codexRateLimits'&&(!c.expiresAt||c.expiresAt*1000>Date.now())).sort((a,b)=>(a.expiresAt||Infinity)-(b.expiresAt||Infinity))[0];
    intent={phase:'pending',accountId:account.id,remoteId,idempotencyKey:randomUUID(),...(first?{creditId:first.id}:{}),createdAt:new Date().toISOString()};
    await atomicJSON(this.path(account),intent);
   }
   if(intent.remoteId!==remoteId||intent.accountId!==account.id)throw new Error('Pending reset belongs to another account');
   const params={idempotencyKey:intent.idempotencyKey,...(intent.creditId?{creditId:intent.creditId}:{})};
   const result=await client.request('account/rateLimitResetCredit/consume',params);
   if(!['reset','alreadyRedeemed','nothingToReset','noCredit'].includes(result?.outcome))throw new Error('Unknown reset outcome; retry this same reset');
   await atomicJSON(this.path(account),{...intent,phase:'complete',outcome:result.outcome,completedAt:new Date().toISOString()});
   let current;try{current=await this.snapshot(account,client,remoteId);}catch{current={account,usage:await this.usage.get(account.id),credits:null,mode:'codex',error:'Reset recorded; refresh usage'};}
   if(['reset','alreadyRedeemed'].includes(result.outcome)&&current.ordinaryUsageAllowed){const usage=await this.usage.get(account.id);if(usage.cooldownReason==='quota')current.usage=await this.usage.patch(account.id,{cooldownUntil:null,cooldownReason:null});}
   this.app.engine.wake?.();return {...current,pending:null,outcome:result.outcome};
  }),{signal});
 }
}
