import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Accounts } from '../src/accounts.mjs';
import { AccountUsage, limitsFromHeaders, usageLabel } from '../src/usage.mjs';
import { fixture } from './helpers.mjs';

const sample = { input: 70, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 120 };

test('request rate headers preserve subscription windows and an authoritative refresh can remove absent windows',async t=>{
  const f=await fixture(t,()=>({text:'ok'})),ledger=new AccountUsage(f.home),account={id:'quota-merge',provider:'anthropic'};
  await ledger.record(account,{limits:[{kind:'quota',label:'5h',usedPercent:25,resetAt:9999999999}],replaceLimits:true});
  const row=await ledger.record(account,{limits:[{kind:'rate',label:'requests',usedPercent:10,remaining:90,limit:100}]});
  assert.equal(row.limits.length,2);assert.match(usageLabel({...account,name:'Claude',type:'oauth'},row),/5h 25%/);
  assert.deepEqual((await ledger.record(account,{limits:[],replaceLimits:true})).limits,[]);
});

test('same-provider accounts keep independent credentials and usage even if another process switches during a request', async t => {
  let switchAccount;
  const f = await fixture(t, async () => {
    if (switchAccount) { const use = switchAccount; switchAccount = null; await use(); }
    return { text: 'OK', headers: { 'x-ratelimit-limit-requests':'100', 'x-ratelimit-remaining-requests':'99' } };
  });
  f.app.registry.register({ ...f.config.customProviders[0], keyless: false });
  const accounts = f.app.registry.accounts;
  const a = await accounts.add('fixture','Personal',{type:'api_key',key:'test-account-a'});
  const b = await accounts.add('fixture','Personal',{type:'api_key',key:'test-account-b'});
  const other = await accounts.add('anthropic','Claude',{type:'api_key',key:'test-claude'});
  await accounts.use(a);
  switchAccount = () => accounts.use(b);
  await f.app.engine.run('First account');
  const ledger = new AccountUsage(f.session.home);
  assert.equal(f.requestHeaders[0].authorization,'Bearer test-account-a');
  assert.equal((await ledger.get(a)).requests,1); assert.equal((await ledger.get(b)).requests,0);
  await f.app.engine.run('Second account');
  assert.equal(f.requestHeaders[1].authorization,'Bearer test-account-b');
  assert.equal((await ledger.get(a)).requests,1); assert.equal((await ledger.get(b)).requests,1);
  assert.equal((await ledger.get(b)).limits[0].remaining,99);
  assert.equal((await ledger.get(other)).requests,0);
  assert.equal((await accounts.list()).filter(a=>a.provider==='fixture').length,2);
  const loaded = new AccountUsage(f.session.home);
  assert.equal((await loaded.get(a)).totalTokens,120);
  const text = await readFile(ledger.path,'utf8'); assert.doesNotMatch(text,/test-account|test-claude|Bearer/);
  assert.equal((await stat(ledger.path)).mode & 0o777,0o600);
});

test('usage updates are serialized and duplicate request receipts are not counted twice', async t => {
  const f=await fixture(t,()=>({text:'Unused'})); const ledger=new AccountUsage(f.session.home);
  const account={id:'account-a',provider:'fixture',name:'Personal'};
  await Promise.all(Array.from({length:5},(_,i)=>ledger.record(account,{usage:sample,requestId:`request-${i}`})));
  await ledger.record(account,{usage:sample,requestId:'request-1'});
  const data=await ledger.get(account.id);
  assert.equal(data.requests,5); assert.equal(data.totalTokens,600); assert.equal(data.cacheRead,150);
});

test('only provider-reported quota/rate numbers are retained; missing and expired quota is not invented', () => {
  const limits=limitsFromHeaders('openai-codex',{
    'X-Codex-Primary-Used-Percent':'37','x-codex-primary-window-minutes':'300','x-codex-primary-reset-at':String(Date.now()/1000+3600),
    'x-codex-secondary-used-percent':'51','x-codex-secondary-window-minutes':'10080',
    authorization:'Bearer test-secret',cookie:'private',
  });
  assert.equal(limits.length,2); assert.equal(limits[0].label,'5h');
  assert.match(usageLabel({name:'Personal',type:'oauth'},{limits,limitsAt:new Date().toISOString()}),/5h 37% used.*7d 51% used/);
  assert.doesNotMatch(JSON.stringify(limits),/test-secret|private/);
  assert.deepEqual(limitsFromHeaders('openai-codex',{}),[]);
  assert.equal(usageLabel({name:'Personal',type:'oauth'},{limits:[{kind:'quota',label:'5h',usedPercent:100,resetAt:1}]}),'Personal');
  const rate=limitsFromHeaders('anthropic',{'anthropic-ratelimit-requests-remaining':'40','anthropic-ratelimit-requests-limit':'50'});
  assert.ok(Math.abs(rate[0].usedPercent-20)<0.001);
  assert.equal(usageLabel({name:'Personal',type:'oauth'},{limits:rate,limitsAt:'2000-01-01T00:00:00Z'}),'Personal');
});

test('a pinned request refreshes the original account after switching and never overwrites the new active account', async t => {
  const f=await fixture(t,()=>({text:'Unused'})); const a=f.app.registry.accounts;
  const first=await a.add('anthropic','First',{type:'oauth',access:'first',refresh:'r1',expires:1});
  const pinned=await a.selected('anthropic');
  const second=await a.add('anthropic','Second',{type:'oauth',access:'second',refresh:'r2',expires:1});
  await a.store(pinned).modify('anthropic',async old=>({...old,access:'renewed-first'}));
  assert.equal((await a.store().read('anthropic')).access,'second');
  assert.equal((await a.store(pinned).read('anthropic')).access,'renewed-first');
  await a.remove(first);
  await assert.rejects(a.store(pinned).read('anthropic'),/removed/);
  assert.equal((await a.selected('anthropic')).id,second);
});

test('account login UI adds several accounts from the same provider and another provider without replacing them', async t => {
  const f=await fixture(t,()=>({text:'Unused'})); let provider='anthropic'; const notes=[];
  f.app.ui={
    choose:async title=>title==='Connect a provider'?provider:'api_key',
    ask:async prompt=>prompt.type==='secret'?'test-api-key':'Personal',
    note:text=>notes.push(text),render:()=>{},stop:()=>{},event:()=>{},
  };
  await f.app.accountMenu('login'); await f.app.accountMenu('login');
  provider='openai'; await f.app.accountMenu('login');
  const accounts=await f.app.registry.accounts.list();
  assert.equal(accounts.length,3); assert.equal(accounts.filter(a=>a.provider==='anthropic').length,2);
  assert.equal(new Set(accounts.map(a=>a.id)).size,3);
  assert.equal(accounts.filter(a=>a.active).length,2);
  assert.equal(f.app.activeAccount.provider,'openai'); assert.equal(f.app.activeAccount.name,'Personal');
  await f.app.registry.accounts.use(accounts[0].id); await f.app.useProvider('anthropic');
  assert.equal(f.app.activeAccount.id,accounts[0].id);
  assert.doesNotMatch(notes.join('\n'),/test-api-key/);
});
