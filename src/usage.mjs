import { join } from 'node:path';
import { atomicJSON, readJSON, withLock, psiHome } from './storage.mjs';

const count = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : null;
const resetValue = value => typeof value === 'string' && value.length < 80 && (/^\d+(?:\.\d+)?$/.test(value) || /^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(value) || /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) ? value : null;
const empty = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
export class AccountUsage {
  constructor(home = psiHome()) { this.home = home; this.path = join(home, 'usage.json'); }
  async get(id) { const data = await readJSON(this.path, { accounts: {} }); return data.accounts[id] || { ...empty(), limits: [] }; }
  async patch(id, patch) {
    return withLock(join(this.home,'usage.lock'),async()=>{
      const data=await readJSON(this.path,{accounts:{}}); const row=data.accounts[id] ||= {...empty(),limits:[],recentRequests:[]};
      Object.assign(row,patch);await atomicJSON(this.path,data);return row;
    });
  }
  async record(account, { usage, limits, requestId, model, replaceLimits=false } = {}) {
    return withLock(join(this.home, 'usage.lock'), async () => {
      const data = await readJSON(this.path, { accounts: {} });
      const row = data.accounts[account.id] ||= { ...empty(), provider: account.provider, limits: [], recentRequests: [], firstSeenAt: new Date().toISOString() };
      if (usage && !row.recentRequests.includes(requestId)) {
        row.requests++;
        for (const k of ['input','output','cacheRead','cacheWrite']) row[k] += count(usage[k]) || 0;
        row.totalTokens += count(usage.totalTokens) ?? ['input','output','cacheRead','cacheWrite'].reduce((n,k)=>n+(count(usage[k])||0),0);
        row.recentRequests = [...row.recentRequests, requestId].slice(-1000);
      }
      if (limits?.length || replaceLimits) {
        const at=new Date().toISOString(),fresh=(limits || []).map(l=>({...l,reportedAt:at}));
        row.limits = replaceLimits ? fresh : [...new Map([...(row.limits || []),...fresh].map(l=>[`${l.kind}:${l.label}`,l])).values()];
        row.limitsAt = at;
      }
      row.updatedAt = new Date().toISOString(); if (model) row.model = model;
      await atomicJSON(this.path, data); return row;
    });
  }
}
// Keep only numeric limit information. Never persist arbitrary headers or bearer credentials.
export function limitsFromHeaders(provider, raw) {
  const headers = Object.fromEntries(Object.entries(raw || {}).map(([k,v])=>[k.toLowerCase(),String(v)]));
  const limits = [];
  if (provider === 'openai-codex' || provider === 'openai') for (const window of ['primary','secondary']) {
    const used = count(headers[`x-codex-${window}-used-percent`]);
    if (used === null) continue;
    const minutes = count(headers[`x-codex-${window}-window-minutes`]);
    limits.push({ kind: 'quota', label: minutes ? minutes === 10080 ? '7d' : minutes % 60 === 0 ? `${minutes/60}h` : `${minutes}m` : window, usedPercent: Math.min(100,used), resetAt: count(headers[`x-codex-${window}-reset-at`]) });
  }
  for (const resource of ['requests','tokens']) {
    const prefix = provider === 'anthropic' ? `anthropic-ratelimit-${resource}` : null;
    const remaining = count(headers[prefix ? `${prefix}-remaining` : `x-ratelimit-remaining-${resource}`]);
    const limit = count(headers[prefix ? `${prefix}-limit` : `x-ratelimit-limit-${resource}`]);
    if (remaining === null || !limit) continue;
    limits.push({ kind: 'rate', label: resource, remaining, limit, usedPercent: Math.max(0,Math.min(100,100*(1-remaining/limit))), reset: resetValue(headers[prefix ? `${prefix}-reset` : `x-ratelimit-reset-${resource}`]) });
  }
  return limits;
}
export function compactCount(n = 0) {
  return n >= 1e6 ? `${(n/1e6).toFixed(1)}m` : n >= 1e3 ? `${(n/1e3).toFixed(1)}k` : String(Math.round(n));
}
export function quotaFreshness(usage={},now=Date.now()){
 if(!usage?.quotaCheckedAt)return '';
 if(usage.quotaError)return 'cached';
 return now-Date.parse(usage.quotaCheckedAt)>60000?'stale':'';
}
export const remainingPercent=used=>Math.round(Math.max(0,Math.min(100,100-used))*10)/10;
export function applicableQuota(usage={},now=Date.now()){
 usage||={};
 const limits=(usage.limits||[]).filter(l=>l.kind==='quota'&&Number.isFinite(l.usedPercent)&&l.usedPercent>=0&&l.usedPercent<=100&&(l.resetAt?l.resetAt*1000>now:now-Date.parse(l.reportedAt||usage.limitsAt||'')<300000));
 return limits.find(l=>l.label==='5h')||limits.find(l=>['7d','1w','weekly'].includes(l.label))||limits[0]||null;
}
export function usageLabel(account, usage = {}, { sessionCost, costKnown=true,omitQuota,remaining=false,compact=false,weeklyOnly=false } = {}) {
  if (!account) return 'No account connected · /accounts';
  const prefix = account.name || 'Environment / local';
  const now = Date.now()/1000;
  const rank=l=>l.label==='5h'?0:['7d','1w','weekly'].includes(l.label)?1:2;
  const quota=(usage.limits || []).filter(l=>l.kind==='quota' && (!weeklyOnly||['7d','1w','weekly'].includes(l.label)) && l.label!==omitQuota && (l.resetAt ? l.resetAt>now : Date.now()-Date.parse(l.reportedAt||usage.limitsAt||'')<300000)).sort((a,b)=>rank(a)-rank(b));
  if(account.billingMode==='subscription'||(account.billingMode===undefined&&account.type==='oauth')) return prefix+(quota.length?' · '+quota.map(l=>`${l.label} ${remaining?remainingPercent(l.usedPercent):Math.round(l.usedPercent)}% ${remaining?'left':'used'}`).join(' · '):'');
  if(sessionCost!==undefined) return `${prefix} · session ${costKnown?'$'+sessionCost.toFixed(4):'cost unavailable'}${compact?'':' · '+compactCount(usage.totalTokens || 0)+' tokens'}`;
  return `${prefix} · ${compactCount(usage.totalTokens || 0)} tokens · ${usage.requests || 0} calls in Psi`;
}

// Subscription metadata only; never invent reset windows or credits for API plans.
export function accountResetLabel(account,usage={},now=Date.now()){
 if(account.type!=='oauth')return '';
 const parts=[];
 for(const [labels,label]of[[['5h'],'5h'],[['7d','1w','weekly'],'week']]){
  const window=(usage.limits||[]).find(l=>l.kind==='quota'&&labels.includes(l.label));
  if(!window)continue;
  const left=window.resetAt*1000-now;
  let time='?';
  if(Number.isFinite(window.resetAt)&&window.resetAt>0){const m=Math.ceil(Math.max(0,left)/60000),h=Math.floor(m/60),d=Math.floor(h/24);time=left<=0?'due':d?`${d}d ${h%24}h`:h?`${h}h ${m%60}m`:`${m}m`;}
  parts.push(`${label} ${time}`);
 }
 if(Number.isSafeInteger(usage.resetCredits?.availableCount)&&usage.resetCredits.availableCount>=0)parts.push(`resets ${usage.resetCredits.availableCount}`);
 if(!parts.length&&['openai-codex','openai','anthropic'].includes(account.provider)&&(!usage.quotaCheckedAt||usage.quotaError))return 'resets unavailable';
 return parts.join(' · ')+(usage.quotaError&&parts.length?' · cached':'');
}
