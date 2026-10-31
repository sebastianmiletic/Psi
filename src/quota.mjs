import { AccountUsage } from './usage.mjs';
import { withLock } from './storage.mjs';
import { join } from 'node:path';

const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const unix = value => typeof value === 'number' ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value)/1000 : null;
export function parseQuota(provider, body) {
  const limits = [];
  if (provider === 'anthropic') {
    for (const [key,label] of [['five_hour','5h'],['seven_day','7d']]) {
      const w=body[key]; if (!w || w.unlimited === true || w.has_limit === false) continue;
      const percent=w.utilization ?? w.used_percentage;
      if (validPercent(percent)) limits.push({kind:'quota',label,usedPercent:percent,resetAt:unix(w.resets_at)});
    }
  } else {
    const rate=body.rate_limit || body.rateLimits || body;
    for (const [key,fallback] of [['primary_window','5h'],['secondary_window','7d'],['primary','5h'],['secondary','7d']]) {
      const w=rate[key]; if (!w || w.unlimited === true || w.limit === null || w.limit_window_seconds===0 || w.windowDurationMins===0) continue;
      const percent=w.used_percent ?? w.usedPercent; const mins=w.limit_window_seconds ? w.limit_window_seconds/60 : w.windowDurationMins;
      const label=mins ? mins===10080?'7d':mins%60===0?`${mins/60}h`:`${mins}m`:fallback;
      if (validPercent(percent) && !limits.some(l=>l.label===label)) limits.push({kind:'quota',label,usedPercent:percent,resetAt:unix(w.reset_at ?? w.resetsAt)});
    }
  }
  return { limits, plan: typeof body.plan_type === 'string' ? body.plan_type : null };
}
export class QuotaMonitor {
  constructor(registry, config, home, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.registry=registry;this.config=config;this.home=home;this.fetch=fetchImpl;this.now=now;this.pending=new Map();
    this.usage=new AccountUsage(home);
  }
  async refresh(account, { force=false, signal } = {}) {
    if (account?.type !== 'oauth' || !['openai-codex','openai','anthropic'].includes(account.provider)) return this.usage.get(account?.id);
    if (this.pending.has(account.id)) return this.pending.get(account.id);
    const task=this.read(account,{force,signal});this.pending.set(account.id,task);
    try { return await task; } finally { this.pending.delete(account.id); }
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
        const {limits,plan}=parseQuota(account.provider,JSON.parse(text));
        const updated=await this.usage.record(account,{limits,replaceLimits:true});
        return this.usage.patch(account.id,{quotaCheckedAt:new Date(this.now()).toISOString(),quotaRetryAt:null,quotaError:null,plan:plan || updated.plan});
      } catch(e) {
        if (signal?.aborted) throw e;
        return this.usage.patch(account.id,{quotaCheckedAt:new Date(this.now()).toISOString(),quotaError:'Usage service unavailable',quotaRetryAt:new Date(this.now()+120000).toISOString()});
      }
    },{signal});
  }
}
export function exhausted(usage, threshold=100, now=Date.now()) {
  return (usage.limits || []).filter(l=>l.kind==='quota' && (l.resetAt?l.resetAt*1000>now:now-Date.parse(l.reportedAt||usage.limitsAt||'')<300000) && l.usedPercent>=threshold);
}
export class AccountRouter {
  constructor(registry,usage,config,{now=()=>Date.now()}={}) {this.registry=registry;this.usage=usage;this.config=config;this.now=now;}
  async choose(provider, { exclude=[] }={}) {
    const active=await this.registry.accounts.selected(provider);
    if (!this.config.autoSwitchAccounts) {const u=await this.usage.get(active.id);return Date.parse(u.cooldownUntil||'')>this.now()||exhausted(u,100,this.now()).length?null:active;}
    const saved=(await this.registry.accounts.list()).filter(a=>a.provider===provider);
    const order=[active,...saved.filter(a=>a.id!==active.id)];
    for (const account of order) {
      if (exclude.includes(account.id)) continue;
      const u=await this.usage.get(account.id);
      if (Date.parse(u.cooldownUntil || '')>this.now() || exhausted(u,this.config.accountSwitchThreshold || 100,this.now()).length) continue;
      if (account.type!=='ambient') await this.registry.accounts.use(account.id);
      return account;
    }
    return null;
  }
  async block(account, { seconds=60, error='quota' }={}) {
    await this.usage.patch(account.id,{cooldownUntil:new Date(this.now()+seconds*1000).toISOString(),cooldownReason:error});
  }
  async nextReset(provider) {
    const accounts=(await this.registry.accounts.list()).filter(a=>a.provider===provider);
    const times=[];
    for (const a of accounts) {const u=await this.usage.get(a.id);for(const l of exhausted(u,100,this.now()))if(l.resetAt)times.push(l.resetAt*1000);if(u.cooldownUntil)times.push(Date.parse(u.cooldownUntil));}
    return times.filter(t=>t>this.now()).sort((a,b)=>a-b)[0] || this.now()+60000;
  }
}
