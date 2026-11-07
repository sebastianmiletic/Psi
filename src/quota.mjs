import { AccountUsage } from './usage.mjs';
import { withLock } from './storage.mjs';
import { join } from 'node:path';

const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const unix = value => typeof value === 'number'&&Number.isFinite(value)?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value)/1000 : null;
export function parseQuota(provider, body, now=Date.now()) {
  const limits = [];
  const add=(label,w)=>{
    if(!w||typeof w!=='object'||w.unlimited===true||w.has_limit===false||w.limit===null||w.limit_window_seconds===0||w.windowDurationMins===0)return;
    const percent=w.utilization??w.used_percentage??w.used_percent??w.usedPercent??(w.limit_reached===true||w.allowed===false?100:undefined);
    const reset=unix(w.resets_at??w.reset_at??w.resetsAt)??(Number.isFinite(w.reset_after_seconds)?now/1000+w.reset_after_seconds:null);
    if(validPercent(percent)&&!limits.some(l=>l.label===label))limits.push({kind:'quota',label,usedPercent:percent,resetAt:reset});
  };
  if(provider==='anthropic'){
    for(const [key,w]of Object.entries(body))add(key==='five_hour'?'5h':key==='seven_day'?'7d':key.startsWith('seven_day_')?key.replace('seven_day_','7d '):key.replaceAll('_',' '),w);
  }else{
    const rates=[[body.rate_limit||body.rateLimits||body,'']];
    for(const extra of Array.isArray(body.additional_rate_limits)?body.additional_rate_limits:[])if(extra?.rate_limit)rates.push([extra.rate_limit,extra.limit_name||extra.metered_feature||'additional']);
    if(body.rateLimitsByLimitId)for(const [name,rate]of Object.entries(body.rateLimitsByLimitId))rates.push([rate,name]);
    for(const [rate,prefix]of rates){
      if(!rate||typeof rate!=='object')continue;

      for(const [key,fallback]of [['primary_window','5h'],['secondary_window','7d'],['primary','5h'],['secondary','7d']]){
        const w=rate[key];if(!w)continue;
        const mins=w.limit_window_seconds?w.limit_window_seconds/60:w.windowDurationMins;
        const label=mins?mins===10080?'7d':mins%60===0?`${mins/60}h`:`${mins}m`:fallback;
        add(prefix?`${prefix} ${label}`:label,w);
      }
      if(rate.limit_reached===true||rate.allowed===false)add(prefix?`${prefix} usage`:'usage',rate);
    }
  }
  return {limits,plan:typeof body.plan_type==='string'?body.plan_type:null};
}
function observeQuota(task,signal){
  if(!signal)return task;
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason||new Error('Stopped'));};
    signal.addEventListener('abort',abort,{once:true});
    task.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
export class QuotaMonitor {
  constructor(registry, config, home, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.registry=registry;this.config=config;this.home=home;this.fetch=fetchImpl;this.now=now;this.pending=new Map();
    this.usage=new AccountUsage(home);
  }
  async refresh(account, { force=false, signal } = {}) {
    signal?.throwIfAborted();
    if (account?.type !== 'oauth' || !['openai-codex','openai','anthropic'].includes(account.provider)) return this.usage.get(account?.id);
    const existing=this.pending.get(account.id);
    if(existing){
      try{return await observeQuota(existing.task,signal);}
      catch(error){
        signal?.throwIfAborted();
        // The UI may have cancelled its poll while inference was sharing it.
        if(!existing.signal?.aborted)throw error;
        if(this.pending.get(account.id)===existing)this.pending.delete(account.id);
        return this.refresh(account,{force,signal});
      }
    }
    const entry={signal,task:this.read(account,{force,signal})};this.pending.set(account.id,entry);
    try { return await observeQuota(entry.task,signal); }
    finally { if(this.pending.get(account.id)===entry)this.pending.delete(account.id); }
  }
  async read(account,{force,signal}) {
    return withLock(join(this.home,'quota',`${account.id}.lock`),async()=>{
      let data=await this.usage.get(account.id);
      const interval=Math.max(5000,Math.min(30,this.config.quotaRefreshSeconds||15)*1000);
      if ((!force && this.now()-Date.parse(data.quotaCheckedAt || '')<interval) || Date.parse(data.quotaRetryAt || '')>this.now()) return data;
      try {
        const models=this.registry.forAccount(account);
        // Resolve and refresh through Psi's locked account store, never through another app's login.
        const auth=await models.getAuth(account.provider);
        const credential=await this.registry.accounts.store(account).read(account.provider);
        if (!auth || !credential?.access) return data;
        const claude=account.provider==='anthropic';
        const url=claude?'https://api.anthropic.com/api/oauth/usage':'https://chatgpt.com/backend-api/wham/usage';
        const headers={Authorization:`Bearer ${credential.access}`,Accept:'application/json'};
        if (claude) headers['anthropic-beta']='oauth-2025-04-20';
        else if (credential.accountId) headers['ChatGPT-Account-Id']=credential.accountId;
        const response=await this.fetch(url,{headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
        if (!response.ok) {
          const seconds=Number(response.headers.get('retry-after'));
          const wait=response.status===429?Math.max(Number.isFinite(seconds)?seconds:0,300):120;
          await response.body?.cancel();
          return this.usage.patch(account.id,{quotaCheckedAt:new Date(this.now()).toISOString(),quotaRetryAt:new Date(this.now()+wait*1000).toISOString(),quotaError:`HTTP ${response.status}`});
        }
        const text=await response.text(); if (text.length>250000) throw new Error('Usage response too large');
        const {limits,plan}=parseQuota(account.provider,JSON.parse(text),this.now());
        const updated=await this.usage.record(account,{limits,replaceLimits:true});
        return this.usage.patch(account.id,{quotaCheckedAt:new Date(this.now()).toISOString(),quotaRetryAt:null,quotaError:null,plan:plan || updated.plan});
      } catch(e) {
        if (signal?.aborted) throw e;
        return this.usage.patch(account.id,{quotaCheckedAt:new Date(this.now()).toISOString(),quotaError:'Usage service unavailable',quotaRetryAt:new Date(this.now()+120000).toISOString()});
      }
    },{signal});
  }
}
export function limitResetAt(limit,usage={}) {
  const reset=unix(limit.resetAt);if(reset!==null&&reset>0)return reset*1000;
  if(typeof limit.reset!=='string')return null;
  const direct=unix(limit.reset);if(direct!==null)return direct*1000;
  const duration=[...limit.reset.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if(!duration.length||duration.map(m=>m[0]).join('')!==limit.reset)return null;
  const reported=Date.parse(limit.reportedAt||usage.limitsAt||'');
  return Number.isFinite(reported)?reported+duration.reduce((n,m)=>n+Number(m[1])*({ms:1,s:1000,m:60000,h:3600000,d:86400000}[m[2]]),0):null;
}
export function exhausted(usage={}, threshold=100, now=Date.now()) {
  return (usage.limits || []).filter(l=>{
    const reset=limitResetAt(l,usage),fresh=reset!==null?reset>now:now-Date.parse(l.reportedAt||usage.limitsAt||'')<300000;
    return fresh&&(l.kind==='quota'&&l.usedPercent>=threshold||l.kind==='rate'&&l.remaining===0);
  });
}
export class AccountRouter {
  constructor(registry,usage,config,{now=()=>Date.now()}={}) {this.registry=registry;this.usage=usage;this.config=config;this.now=now;}
  async choose(provider, { exclude=[], refresh }={}) {
    const active=await this.registry.accounts.selected(provider);
    if (!this.config.autoSwitchAccounts) {if(exclude.includes(active.id))return null;const u=await (refresh?.(active)||this.usage.get(active.id));return Date.parse(u.cooldownUntil||'')>this.now()||exhausted(u,100,this.now()).length?null:active;}
    const saved=(await this.registry.accounts.list()).filter(a=>a.provider===provider);
    const order=[active,...saved.filter(a=>a.id!==active.id)];
    for (const account of order) {
      if (exclude.includes(account.id)) continue;
      const u=await (refresh?.(account)||this.usage.get(account.id));
      if (Date.parse(u.cooldownUntil || '')>this.now() || exhausted(u,this.config.accountSwitchThreshold || 100,this.now()).length) continue;
      return account;
    }
    return null;
  }
  async block(account, { seconds=60, error='quota' }={}) {
    await this.usage.patch(account.id,{cooldownUntil:new Date(this.now()+seconds*1000).toISOString(),cooldownReason:error});
  }
  async nextReset(provider) {
    const active=await this.registry.accounts.selected(provider),accounts=(await this.registry.accounts.list()).filter(a=>a.provider===provider);
    if(!accounts.some(a=>a.id===active.id))accounts.push(active);
    const times=[];
    for(const account of accounts){
      const usage=await this.usage.get(account.id),blocked=exhausted(usage,this.config.accountSwitchThreshold||100,this.now());
      const resets=blocked.map(l=>limitResetAt(l,usage)??this.now()+60000),cooldown=Date.parse(usage.cooldownUntil||'');
      if(cooldown>this.now())resets.push(cooldown);
      if(resets.length)times.push(Math.max(...resets));
    }
    return times.filter(t=>t>this.now()).sort((a,b)=>a-b)[0]||this.now()+60000;
  }
}
