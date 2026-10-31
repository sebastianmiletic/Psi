import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Agents } from './agents.mjs';
import { registerProgress } from './progress.mjs';
import { checkUpdate,updateInstallation } from './updates.mjs';
import { readFile, writeFile, stat, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { Battlecode } from './battlecode.mjs';
import { settingItems } from './settings.mjs';
import { accents } from './theme.mjs';
import { AccountUsage, usageLabel } from './usage.mjs';
import { Registry } from './providers.mjs';
import { Session } from './session.mjs';
import { Jobs } from './jobs.mjs';
import { Tools } from './tools.mjs';
import { Engine } from './engine.mjs';
import { saveConfig, psiHome, cleanTerminal, redact } from './storage.mjs';

export class App {
  constructor(config, session, options = {}) {
    this.config = config; this.session = session; this.options = options;
    this.home = options.home || psiHome(); this.registry = new Registry(config, this.home); this.accountUsage = new AccountUsage(this.home); this.activeAccount = null; this.activeUsage = null;
    this.bind();
  }
  bind() {
    this.jobs = new Jobs(this.home, this.session.meta.id);
    this.tools = new Tools({ session: this.session, jobs: this.jobs, config: { ...this.config, ...this.session.state.settings }, onEvent: e => this.event(e) });
    this.battlecode=new Battlecode({session:this.session,jobs:this.jobs,config:this.config,home:this.home});this.tools.projectAdapter=this.battlecode;
    this.engine = new Engine({ registry: this.registry, session: this.session, tools: this.tools, config: this.config, onEvent: e => this.event(e) });
    this.battlecode.config=this.engine.config;
    this.agents=new Agents(this);this.tools.stopAgents=()=>this.agents.stopAll();
    registerProgress(this.tools,this.session,e=>this.event(e));
    this.syncProjectTools();
  }
  syncProjectTools() {
    this.tools.entries.delete('agent');if(this.engine.config.overkill&&!(this.engine.config.subagentDepth>=1))this.agents.register();
    for(const name of this.tools.entries.keys())if(name.startsWith('battlecode_'))this.tools.entries.delete(name);
    if(this.engine.config.profile==='battlecode'&&existsSync(join(this.session.meta.cwd,'tools/vision/live_trial.py')))this.battlecode.register(this.tools);
  }
  event(event) {
    if(event.type==='settings')this.syncProjectTools();
    if (event.account && event.account.provider === this.engine.model.provider) {
      this.activeAccount = event.account;
      if (event.accountUsage) this.activeUsage = event.accountUsage;
    }
    if (this.engine?.config.debug && !['text_delta', 'thinking_delta'].includes(event.type)) {
      // Verbose operational logging deliberately excludes prompts, credentials, tool arguments and provider payloads.
      const data = { at: new Date().toISOString(), type: event.type, model: event.model, attempt: event.attempt, duration: event.duration, tool: event.call?.name, error: !!event.error, status: event.status };
      void appendFile(join(this.session.dir, 'debug.jsonl'), JSON.stringify(data) + '\n', { mode: 0o600 }).catch(() => {});
    }
    this.ui?.event(event); this.options.onEvent?.(event);
  }
  async refreshAccount({live=false}={}) {
    const account = await this.registry.accounts.selected(this.engine.model.provider);
    const configured = account.type !== 'ambient' || !!await this.registry.models.checkAuth(account.provider);
    account.billingMode=this.registry.billingMode(account);this.activeAccount = configured ? account : null; this.activeUsage = live && account.type==='oauth'?await this.engine.quota.refresh(account,{signal:this.quotaController?.signal}):await this.accountUsage.get(account.id);
    this.ui?.render(); return { account: this.activeAccount, usage: this.activeUsage };
  }
  async startUI() {
    await this.refreshAccount();
    const { TerminalUI } = await import('./ui.mjs'); this.ui = new TerminalUI(this); this.ui.start(); this.startUsageMonitor();
    if(this.engine.config.checkForUpdates)void this.checkUpdates();
    if (this.session.messages.length) {
      this.ui.note(`Resumed ${this.session.meta.id}. ${this.session.messages.length} context messages.`);
      for (const m of this.session.messages.slice(-8)) {
        if (m.role === 'user') this.ui.user(typeof m.content === 'string' ? m.content.slice(0, 2000) : '[Attached content]');
        if (m.role === 'assistant') { const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); if (text) this.ui.markdown(text.slice(-6000)); }
      }
    }
  }
  startUsageMonitor() {
    clearInterval(this.quotaTimer);this.quotaController?.abort();this.quotaController=new AbortController();
    if(this.activeAccount?.type!=='oauth')return;
    const poll=()=>{if(!this.closing)void this.refreshAccount({live:true}).catch(()=>{});};poll();
    this.quotaTimer=setInterval(poll,Math.max(60,this.engine.config.quotaRefreshSeconds||120)*1000);this.quotaTimer.unref();
  }
  async settingsMenu() {
    while(true){
      const c={...this.engine.config,...this.engine.pendingSettings};
      const selected=await this.ui.choose('Settings',settingItems.map(item=>({value:item.id,label:item.label,description:`${item.special==='prices'?'configure':Array.isArray(c[item.id])?c[item.id].join(', ')||'none':typeof c[item.id]==='boolean'?(c[item.id]?'on':'off'):c[item.id]??'default'}${item.description?' · '+item.description:''}`})));
      if(!selected)return;
      const item=settingItems.find(i=>i.id===selected);let value;
      if(item.special==='agents'){await this.agentsMenu();continue;}
      if(item.special==='mode'){await this.setMode(c.agentMode==='plan'?'execute':'plan');continue;}
      if(item.special==='model'){await this.selectModel();continue;}
      if(item.special==='effort'){value=await this.ui.choose('Thinking effort',getSupportedThinkingLevels(this.engine.model).map(v=>({value:v,label:v})));if(!value)continue;}
      else if(item.special==='prices'){
        const key=this.engine.config.model,previous=c.customPrices?.[key]||this.engine.model.cost,prices={};let cancelled=false;
        for(const field of ['input','output','cacheRead','cacheWrite']){const answer=await this.ui.ask({type:'text',message:`${field} USD per million tokens`,placeholder:String(previous[field]||0)});if(answer===null){cancelled=true;break;}const n=Number(answer);if(!Number.isFinite(n)||n<0){this.ui.note('Enter a nonnegative price.',true);cancelled=true;break;}prices[field]=n;}
        if(!cancelled)await this.update({customPrices:{...c.customPrices,[key]:prices}});continue;
      } else if(item.boolean)value=!c[item.id];
      else if(item.values){value=await this.ui.choose(item.label,item.values.map(v=>({value:v,label:v})));if(value===null)continue;if(item.id==='accent'&&value==='custom'){value=await this.ui.ask({type:'text',message:'Accent colour',placeholder:'#80cda8 or oklch(70% 0.12 200)'});if(!value)continue;}}
      else{value=await this.ui.ask({type:'text',message:item.label,placeholder:item.id==='fallbackModels'?'openai-codex/model, anthropic/model':String(c[item.id]??'')});if(value===null)continue;
        if(item.number)value=Number(value);else if(item.id==='fallbackModels')value=value.split(',').map(s=>s.trim()).filter(Boolean);else if(item.id==='summaryModel')value=value==='same'||!value?null:value;}
      try{await this.update({[item.id]:value});}catch(e){this.ui.note(e.message,true);}
    }
  }
  async changeSession(session) {
    if (this.engine.busy) throw new Error('Stop the current run first.');
    await this.tools.close(); this.session = session; this.bind();
    if (this.ui) { const { CombinedAutocompleteProvider } = await import('@earendil-works/pi-tui'); const { commands } = await import('./ui.mjs'); this.ui.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, session.meta.cwd)); }
    await this.refreshAccount();
    if(this.ui)this.startUsageMonitor();
    this.ui?.clear(); this.ui?.note(`Session ${session.meta.id}\n${session.meta.cwd}`);
  }
  async update(patch) { await this.engine.settings(patch); this.config = await saveConfig(patch, this.home); await this.refreshAccount(); if(this.ui)this.startUsageMonitor(); this.engine.wake?.(); }
  async selectModel(query = '') {
    if (query) {
      let model; try { model = this.registry.find(query); } catch (e) { if (!this.ui) throw e; }
      if (model) { await this.update({ model: `${model.provider}/${model.id}` }); this.ui?.note(`Model: ${this.engine.config.model}`); return; }
    }
    const accounts = await this.registry.accounts.list(); const connected = new Set(accounts.map(a => a.provider));
    const models = this.registry.all().filter(m => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()));
    models.sort((a, b) => Number(connected.has(b.provider)) - Number(connected.has(a.provider)) || `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    const choice = await this.ui.choose('Model', models.map(m => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, description: `${m.reasoning ? 'reasoning · ' : ''}${Math.round(m.contextWindow / 1000)}k context${connected.has(m.provider) ? ' · connected' : ''}` })));
    if (choice) { await this.update({ model: choice }); this.ui.note(`Model: ${choice}`); }
  }
  async accountMenu(action) {
    if (this.engine.busy&&!this.engine.waiting) throw new Error('Press Escape twice to stop before changing accounts, or wait for a quota pause.');
    action ||= await this.ui.choose('Accounts', [
      { value: 'login', label: 'Login new account', description: 'Add any provider, including another account with the same provider' },
      { value: 'switch', label: 'Switch accounts', description: 'Choose any saved account' },
      { value: 'remove', label: 'Remove account', description: 'Delete a saved credential from Psi' },
    ]);
    if (!action) return;
    if (action === 'login') {
      const providers = [...this.registry.models.getProviders()].sort((a, b) => Number(!!b.auth.oauth) - Number(!!a.auth.oauth) || a.name.localeCompare(b.name));
      const id = await this.ui.choose('Connect a provider', providers.map(p => ({ value: p.id, label: p.name, description: `${p.id} · ${p.auth.oauth ? 'sign-in' : 'API key'}` })));
      if (!id) return;
      const p = this.registry.models.getProvider(id);
      let type = p.auth.oauth ? 'oauth' : 'api_key';
      if (p.auth.oauth && p.auth.apiKey?.login) type = await this.ui.choose('Connection method', [{ value: 'oauth', label: p.auth.oauth.loginLabel || p.auth.oauth.name }, { value: 'api_key', label: p.auth.apiKey.name }]);
      if (!type) return;
      const name = await this.ui.ask({ type: 'text', message: 'Name this account', placeholder: 'e.g. Personal, School, Team' });
      if (!name) return;
      const controller = new AbortController(); this.authController = controller;
      try {
        await this.registry.accounts.login(this.registry, id, name, type, {
          signal: controller.signal,
          prompt: async prompt => { const answer = await this.ui.ask(prompt); if (answer === null) { controller.abort(); throw new Error('Login cancelled.'); } return answer; },
          notify: event => {
            if (event.type === 'auth_url') {
              this.ui.note(`Sign in: ${event.url}\n${event.instructions || ''}`);
              if (!process.env.PSI_NO_BROWSER) { const child = spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', event.url] : [event.url], { stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
            } else if (event.type === 'device_code') this.ui.note(`Open ${event.verificationUri}\nCode: ${event.userCode}`);
            else this.ui.note(event.message || 'Signing in…');
          },
        });
        this.ui.note(`Connected ${p.name} · ${name}.`);
        await this.useProvider(id);
      } finally { this.authController = null; }
    } else if (action === 'switch' || action === 'remove') {
      const accounts = await this.registry.accounts.list();
      const usage = new Map(await Promise.all(accounts.map(async a => [a.id, await this.accountUsage.get(a.id)])));
      const id = await this.ui.choose(action === 'switch' ? 'Switch accounts' : 'Remove account', accounts.map(a => ({ value: a.id, label: `${a.active ? '✓ ' : ''}${a.provider} · ${a.name}`, description: `${a.type === 'oauth' ? 'sign-in' : 'API key'} · ${a.id.slice(0,8)} · ${usage.get(a.id).requests} calls in Psi` })));
      if (!id) return;
      if (action === 'switch') { const provider = await this.registry.accounts.use(id); await this.useProvider(provider); this.ui.note('Account switched.'); }
      else { await this.registry.accounts.remove(id); await this.refreshAccount(); this.ui.note('Account removed.'); }
    } else throw new Error('Use /accounts login, switch, or remove.');
  }
  async useProvider(provider) {
    const current = this.engine.model;
    const same = this.registry.models.getModel(provider, current.id);
    const fallback = same || this.registry.models.getModels(provider)[0];
    if (fallback) await this.update({ model: `${provider}/${fallback.id}` });
  }
  async addProvider() {
    const id = await this.ui.ask({ type: 'text', message: 'Provider ID', placeholder: 'my-server' }); if (!id) return;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Use lowercase letters, numbers, hyphens and underscores.');
    const baseUrl = await this.ui.ask({ type: 'text', message: 'API base URL', placeholder: 'http://localhost:8000/v1' }); if (!baseUrl) return;
    const api = await this.ui.choose('API format', [{ value: 'openai-completions', label: 'OpenAI chat completions' }, { value: 'openai-responses', label: 'OpenAI Responses' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]); if (!api) return;
    const model = await this.ui.ask({ type: 'text', message: 'Model ID', placeholder: 'Exact model name from your server' }); if (!model) return;
    const mode = await this.ui.choose('Authentication', [{ value: 'key', label: 'API key' }, { value: 'local', label: 'No key (local server)' }]); if (!mode) return;
    const p = { id, name: id, baseUrl, api, keyless: mode === 'local', models: [{ id: model }] };
    this.registry.register(p); await this.update({ customProviders: [...this.config.customProviders.filter(x => x.id !== id), p] });
    await this.selectModel(`${id}/${model}`);
    if (mode === 'key') {
      const key = await this.ui.ask({ type: 'secret', message: 'API key' }); if (key) await this.registry.accounts.add(id, 'Default', { type: 'api_key', key });
    }
    this.ui.note(`Provider added: ${id}`);
  }
  async submit(text) {
    if (!text.startsWith('/')) {
      this.ui?.user(text);
      if (this.engine.busy) this.engine.steer(text); else await this.engine.run(text).catch(() => {});
      return;
    }
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim()); const command = match?.[1]; const arg = match?.[2] || '';
    if (this.authController && !['quit', 'help'].includes(command)) throw new Error('Finish or cancel account sign-in first.');
    if (this.engine.busy && !this.engine.waiting && !['settings','agents','directory','update','logo','usage','tools','project','experiments','cost','status','help','quit'].includes(command)) throw new Error('Press Escape twice to stop, or enter a message to queue it at the next tool boundary.');
    if(['continue','stop','jobs','budget','limit','tokens'].includes(command))throw new Error(`/${command} was removed. Use /settings for limits, /agents for workers, or Escape twice to stop.`);
    if(command==='settings')return this.settingsMenu();
    if(command==='agents')return this.agentsMenu();
    if(command==='directory')return this.directoryCommand(arg);
    if(command==='update'){if(this.engine.busy)throw new Error('Stop the active run before updating Psi.');this.ui.note('Checking GitHub releases…');this.ui.note((await updateInstallation(this.home)).message);return;}

    if(command==='project'){const p=await this.battlecode.inspect();this.ui.note(JSON.stringify({project:p.project,baseline:p.baseline,version:p.baselineVersion,source:p.baselineHashes.fingerprint,cli:p.cli,controllers:p.scripts,policy:p.policy},null,2));return;}
    if(command==='experiments'){const list=arg?await this.battlecode.reconcile(arg):await this.battlecode.store.list(this.session.meta.cwd);this.ui.note(JSON.stringify(list,null,2));return;}
    if (command === 'logo') { this.ui.showLogo(); return; }
    if (command === 'quit' || command === 'exit') return this.close();
    if (command === 'help') { const { commands } = await import('./ui.mjs'); this.ui.markdown(commands.map(c => `**/${c.name}**  ${c.description}`).join('\n\n')); return; }
    if (command === 'model') return this.selectModel(arg);
    if (command === 'summary-model') {
      if (!arg) { this.ui.note(`Compaction model: ${this.engine.config.summaryModel || 'same as main model'}. Use /summary-model provider/model or /summary-model same.`); return; }
      if (arg !== 'same') this.registry.find(arg);
      await this.update({ summaryModel: arg === 'same' ? null : arg }); this.ui.note(`Compaction model: ${arg}`); return;
    }
    if (command === 'accounts' || command === 'login') return this.accountMenu(command === 'login' ? 'login' : arg);
    if (command === 'provider') return this.addProvider();
    if (command === 'effort') {
      const levels = getSupportedThinkingLevels(this.engine.model);
      const effort = arg || await this.ui.choose('Thinking effort', levels.map(value => ({value,label:value})),{status:()=>`OVERKILL ${this.engine.config.overkill?'ON':'off'} · tab toggle · /agents configure`,onTab:async()=>this.update({overkill:!this.engine.config.overkill})});
      if(effort){await this.update({effort});this.ui.note(`Thinking: ${effort}`);}return;
    }
    if (command === 'profile') { if (!['battlecode', 'general'].includes(arg)) throw new Error('Use /profile battlecode or /profile general.'); await this.update({ profile: arg }); this.ui.note(`Profile: ${arg}`); return; }
    if (command === 'usage') {
      const { account, usage } = await this.refreshAccount({live:true});
      this.ui.note(usageLabel(account,usage,{sessionCost:this.session.meteredCost,costKnown:this.session.meteredCostKnown}));
      this.ui.note('Subscription windows are refreshed from the provider and omitted when absent. API session cost uses returned billed USD when supplied, otherwise actual token usage at configured model rates; provider invoices can differ. Token counters cover Psi activity across sessions.');
      if (usage.limits?.length) this.ui.note(JSON.stringify({ reportedAt: usage.limitsAt, limits: usage.limits },null,2));
      return;
    }
    if (command === 'tools') {
      this.ui.markdown(this.tools.definitions().map(tool => `**${tool.name}**  ${tool.description}`).join('\n\n')); return;
    }
    if (command === 'cost') {
      const u = this.session.totals; const cached = u.input + u.cacheRead ? Math.round(u.cacheRead / (u.input + u.cacheRead) * 100) : 0;
      this.ui.note(`${u.requests} requests · ${u.input.toLocaleString()} input · ${u.output.toLocaleString()} output · ${u.cacheRead.toLocaleString()} cache read (${cached}%)\nEstimated catalog cost: $${u.cost.toFixed(5)}. Subscription quotas, tiered pricing and unknown/custom prices are not measured.`); return;
    }
    if (command === 'status') { this.ui.note(JSON.stringify({ session: this.session.meta.id, cwd: this.session.meta.cwd, directories:await this.tools.policy.roots(),status: this.session.status,mode:this.engine.config.agentMode,overkill:this.engine.config.overkill,model: this.engine.config.model, effort: this.engine.config.effort, profile: this.engine.config.profile, budget: this.engine.config.budget || 'unlimited', maxSteps: this.engine.config.maxSteps || 'unlimited', access: 'approved directories; no approval prompts', objective: this.session.state.loopGoal || null }, null, 2)); return; }
    if (command === 'loop') { const objective=arg || await this.ui.ask({type:'text',message:'What should Psi achieve?',placeholder:'Describe the goal and how success can be verified'}); if(!objective?.trim())return; this.ui.user(objective); await this.engine.run(objective, { loop: true }).catch(() => {}); return; }
    if (command === 'compact') { await this.engine.run(null, { compactOnly: true }).catch(() => {}); return; }
    if (command === 'checkpoint') {
      const path = join(this.session.dir, 'checkpoint.md');
      if (arg) { await writeFile(path, arg, { mode: 0o600 }); this.ui.note('Checkpoint saved.'); }
      else this.ui.markdown(await readFile(path, 'utf8').catch(() => 'No checkpoint yet.')); return;
    }
    if (command === 'new') return this.changeSession(await Session.create(this.session.meta.cwd, this.home));
    if (command === 'cd') { if (!arg) { this.ui.note(this.session.meta.cwd); return; } const cwd = resolve(this.session.meta.cwd, arg.replace(/^~(?=\/|$)/, process.env.HOME || '~')); if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory.'); return this.changeSession(await Session.create(cwd, this.home)); }
    if (command === 'resume') {
      const sessions = await Session.list(this.home);
      const id = arg || await this.ui.choose('Resume session', sessions.map(s => ({ value: s.id, label: s.title, description: `${s.createdAt.slice(0, 16)} · ${s.cwd}` })));
      if (id) await this.changeSession(await Session.load(id, this.home)); return;
    }
    if (command === 'refresh') { this.ui.note('Refreshing model catalog…'); const result = await this.registry.refresh(arg || this.engine.model.provider); this.ui.note(result.errors.size ? [...result.errors].map(([p, e]) => `${p}: ${e.message}`).join('\n') : 'Provider catalog refreshed.'); return; }
    if (command === 'export') { const path = resolve(this.session.meta.cwd, arg || `psi-${this.session.meta.id}.md`); await writeFile(path, this.exportMarkdown(), { mode: 0o600 }); this.ui.note(`Exported: ${path}`); return; }
    throw new Error(`Unknown command: /${command}. Use /help.`);
  }
  async setMode(mode){await this.update({agentMode:mode});this.ui?.note(`${mode==='plan'?'Plan mode: inspect and prepare a plan.':'Execute mode: work within the allowed directories.'}`);}
  async directoryCommand(arg){
    const match=/^(add|remove)(?:\s+([\s\S]+))?$/.exec(arg.trim());
    if(!arg.trim()){this.ui.note('Allowed directories:\n'+(await this.tools.policy.roots()).join('\n')+'\n/directory add <path> · /directory remove <path>');return;}
    if(!match)throw new Error('Use /directory, /directory add <path> or /directory remove <path>.');
    // Existing sandboxes keep their original allowlist, so stop them before revoking access.
    if(this.engine.busy)this.engine.stop();await this.agents.stopAll();
    for(const job of await this.jobs.list())if(job.sessionId===this.session.meta.id&&['running','queued'].includes(job.status)){await this.jobs.stop(job.id);await this.jobs.awaitCompletion(job.id);}
    const path=match[2]?.replace(/^(["'])(.*)\1$/,'$2');const roots=await this.tools.policy.change(match[1],path);this.ui.note('Allowed directories:\n'+roots.join('\n'));
  }
  async checkUpdates(){try{const update=await checkUpdate(this.home);if(!update.available||this.closing)return;if(this.engine.config.autoUpdate&&!this.engine.busy){this.ui.note((await updateInstallation(this.home,{release:update})).message);}else this.ui.note(`Psi ${update.latest} is available. Run /update or psi update, then restart.`);}catch{/* Offline startup remains quiet and fast. */}}
  async agentsMenu(){
    while(true){const c={...this.engine.config,...this.engine.pendingSettings},runs=await this.agents.records();
      const action=await this.ui.choose('OVERKILL workers',[{value:'enabled',label:`OVERKILL ${c.overkill?'ON':'off'}`,description:'Also toggle with Tab inside /effort'},{value:'concurrency',label:'Concurrent workers',description:String(c.subagentConcurrency)},{value:'add',label:'Add a worker profile'},...c.agents.map(p=>({value:'profile:'+p.id,label:p.name,description:`${p.model||'main model'} · ${p.mode} · ${p.job}`})),...runs.map(r=>({value:'run:'+r.id,label:'Run · '+r.name,description:r.prompt.slice(0,100)}))]);if(!action)return;
      if(action==='enabled'){await this.update({overkill:!c.overkill});continue;}
      if(action==='concurrency'){const text=await this.ui.ask({type:'text',message:'Concurrent workers (1–16)',placeholder:String(c.subagentConcurrency)});if(text!==null)try{await this.update({subagentConcurrency:Number(text)});}catch(e){this.ui.note(e.message,true);}continue;}
      if(action.startsWith('run:')){const r=await this.agents.status(action.slice(4));const choice=await this.ui.choose(r.name,[{value:'status',label:'Show status and result'},{value:'send',label:'Send a follow-up'},{value:'stop',label:'Stop this worker'}]);if(choice==='status')this.ui.note(JSON.stringify(r,null,2));if(choice==='stop')await this.jobs.stop(r.jobId);if(choice==='send'){const prompt=await this.ui.ask({type:'text',message:'Follow-up task'});if(prompt){const entry=this.tools.entries.get('agent');if(entry)await entry.execute({action:'send',id:r.id,prompt});}}continue;}
      const profiles=c.agents.map(p=>({...p}));let profile=action==='add'?{id:randomUUID(),name:'Worker',job:'Complete the assigned task and report evidence.',model:null,effort:'medium',mode:'plan',maxSteps:80,budget:0}:profiles.find(p=>p.id===action.slice(8));
      if(action==='add')profiles.push(profile);
      while(true){const field=await this.ui.choose(profile.name,[...['name','job','model','effort','mode','maxSteps','budget'].map(k=>({value:k,label:k,description:String(profile[k]??'main model')})),{value:'remove',label:'Remove this profile'},{value:'save',label:'Save worker'}]);if(!field)break;if(field==='remove'){await this.update({agents:profiles.filter(p=>p.id!==profile.id)});break;}if(field==='save'){try{await this.update({agents:profiles});}catch(e){this.ui.note(e.message,true);continue;}break;}
        let value;if(field==='mode')value=await this.ui.choose('Worker mode',['plan','execute'].map(value=>({value,label:value})));else if(field==='effort'){const model=profile.model?this.registry.find(profile.model):this.engine.model;value=await this.ui.choose('Worker thinking',getSupportedThinkingLevels(model).map(value=>({value,label:value})));}else{value=await this.ui.ask({type:'text',message:field,placeholder:String(profile[field]??'same')});if(value!==null){if(['maxSteps','budget'].includes(field))value=Number(value);if(field==='model'&&(!value||value==='same'))value=null;}}
        if(value!==null||field==='model')profile[field]=value;
      }
    }
  }
  exportMarkdown() {
    return `# Ψ Psi session\n\nWorkspace: ${this.session.meta.cwd}\nSession: ${this.session.meta.id}\n\n` + this.session.messages.map(m => {
      const content = typeof m.content === 'string' ? m.content : m.content.map(c => c.type === 'text' ? c.text : c.type === 'toolCall' ? `Tool: ${c.name}\n\n${JSON.stringify(c.arguments)}` : c.type === 'image' ? '[Image]' : '').join('\n');
      return `## ${m.role}${m.toolName ? `: ${m.toolName}` : ''}\n\n${redact(content)}\n`;
    }).join('\n');
  }
  async close() {
    if (this.closing) return; this.closing = true;
    clearInterval(this.quotaTimer);this.quotaController?.abort();this.authController?.abort(); this.engine.stop(); this.ui?.stop(); await this.tools.close(); this.options.onClose?.();
  }
}
