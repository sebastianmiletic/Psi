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
export function applicableQuota(usage={},now=Date.now()){
 usage||={};
 const limits=(usage.limits||[]).filter(l=>l.kind==='quota'&&Number.isFinite(l.usedPercent)&&l.usedPercent>=0&&l.usedPercent<=100&&(l.resetAt?l.resetAt*1000>now:now-Date.parse(l.reportedAt||usage.limitsAt||'')<300000));
 return limits.find(l=>l.label==='5h')||limits.find(l=>['7d','1w','weekly'].includes(l.label))||limits[0]||null;
}
export function usageLabel(account, usage = {}, { sessionCost, costKnown=true,omitQuota } = {}) {
  if (!account) return 'No account connected · /accounts';
  const prefix = account.name || 'Environment / local';
  const now = Date.now()/1000;
  const quota=(usage.limits || []).filter(l=>l.kind==='quota' && l.label!==omitQuota && (l.resetAt ? l.resetAt>now : Date.now()-Date.parse(l.reportedAt||usage.limitsAt||'')<300000));
  if(account.billingMode==='subscription'||(account.billingMode===undefined&&account.type==='oauth')) return prefix+(quota.length?' · '+quota.map(l=>`${l.label} ${Math.round(l.usedPercent)}% used`).join(' · '):'');
  if(sessionCost!==undefined) return `${prefix} · session ${costKnown?'$'+sessionCost.toFixed(4):'cost unavailable'} · ${compactCount(usage.totalTokens || 0)} tokens`;
  return `${prefix} · ${compactCount(usage.totalTokens || 0)} tokens · ${usage.requests || 0} calls in Psi`;
}
