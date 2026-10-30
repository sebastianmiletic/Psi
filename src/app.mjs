import { readFile, writeFile, stat, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { Registry } from './providers.mjs';
import { Session } from './session.mjs';
import { Jobs } from './jobs.mjs';
import { Tools } from './tools.mjs';
import { Engine } from './engine.mjs';
import { saveConfig, psiHome, cleanTerminal, redact } from './storage.mjs';

export class App {
  constructor(config, session, options = {}) {
    this.config = config; this.session = session; this.options = options;
    this.home = options.home || psiHome(); this.registry = new Registry(config, this.home);
    this.bind();
  }
  bind() {
    this.jobs = new Jobs(this.home, this.session.meta.id);
    this.tools = new Tools({ session: this.session, jobs: this.jobs, config: { ...this.config, ...this.session.state.settings }, onEvent: e => this.event(e) });
    this.engine = new Engine({ registry: this.registry, session: this.session, tools: this.tools, config: this.config, onEvent: e => this.event(e) });
  }
  event(event) {
    if (this.engine?.config.debug && !['text_delta', 'thinking_delta'].includes(event.type)) {
      // Verbose operational logging deliberately excludes prompts, credentials, tool arguments and provider payloads.
      const data = { at: new Date().toISOString(), type: event.type, model: event.model, attempt: event.attempt, duration: event.duration, tool: event.call?.name, error: !!event.error, status: event.status };
      void appendFile(join(this.session.dir, 'debug.jsonl'), JSON.stringify(data) + '\n', { mode: 0o600 }).catch(() => {});
    }
    this.ui?.event(event); this.options.onEvent?.(event);
  }
  async startUI() {
    const { TerminalUI } = await import('./ui.mjs'); this.ui = new TerminalUI(this); this.ui.start();
    if (this.session.messages.length) {
      this.ui.note(`Resumed ${this.session.meta.id}. ${this.session.messages.length} context messages.`);
      for (const m of this.session.messages.slice(-8)) {
        if (m.role === 'user') this.ui.user(typeof m.content === 'string' ? m.content.slice(0, 2000) : '[Attached content]');
        if (m.role === 'assistant') { const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); if (text) this.ui.markdown(text.slice(-6000)); }
      }
    }
  }
  async changeSession(session) {
    if (this.engine.busy) throw new Error('Stop the current run first.');
    await this.tools.close(); this.session = session; this.bind();
    if (this.ui) { const { CombinedAutocompleteProvider } = await import('@earendil-works/pi-tui'); const { commands } = await import('./ui.mjs'); this.ui.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, session.meta.cwd)); }
    this.ui?.clear(); this.ui?.note(`Session ${session.meta.id}\n${session.meta.cwd}`);
  }
  async update(patch) { await this.engine.settings(patch); this.config = await saveConfig(patch, this.home); }
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
    if (this.engine.busy) throw new Error('Stop the current run before changing accounts.');
    action ||= await this.ui.choose('Accounts', [
      { value: 'login', label: 'Login new account', description: 'Connect another provider or account' },
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
      const id = await this.ui.choose(action === 'switch' ? 'Switch accounts' : 'Remove account', accounts.map(a => ({ value: a.id, label: `${a.active ? '✓ ' : ''}${a.provider} · ${a.name}`, description: a.type === 'oauth' ? 'sign-in' : 'API key' })));
      if (!id) return;
      if (action === 'switch') { const provider = await this.registry.accounts.use(id); await this.useProvider(provider); this.ui.note('Account switched.'); }
      else { await this.registry.accounts.remove(id); this.ui.note('Account removed.'); }
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
    if (this.authController && !['stop', 'quit', 'help'].includes(command)) throw new Error('Finish or cancel account sign-in first.');
    if (this.engine.busy && !['stop', 'logo', 'cost', 'status', 'jobs', 'help', 'quit'].includes(command)) throw new Error('Use /stop before changing settings, or type a message to steer the active run.');
    if (command === 'logo') { this.ui.showLogo(); return; }
    if (command === 'quit' || command === 'exit') return this.close();
    if (command === 'stop') { this.authController?.abort(); this.engine.stop(); return; }
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
      const effort = arg || await this.ui.choose('Reasoning effort', levels.map(value => ({ value, label: value })));
      if (effort) { await this.update({ effort }); this.ui.note(`Effort: ${effort}`); } return;
    }
    if (['budget', 'limit', 'tokens'].includes(command)) {
      if (!arg) { this.ui.note(`${command}: ${this.engine.config[{ budget: 'budget', limit: 'maxSteps', tokens: 'maxOutputTokens' }[command]]}`); return; }
      const value = Number(arg);
      if (!Number.isFinite(value) || value < 0 || (command === 'tokens' && value < 256) || (command !== 'budget' && !Number.isInteger(value))) throw new Error('Enter a valid nonnegative number; tokens requires an integer of at least 256.');
      await this.update({ [{ budget: 'budget', limit: 'maxSteps', tokens: 'maxOutputTokens' }[command]]: value }); this.ui.note(`${command}: ${value || 'unlimited'}`); return;
    }
    if (command === 'profile') { if (!['battlecode', 'general'].includes(arg)) throw new Error('Use /profile battlecode or /profile general.'); await this.update({ profile: arg }); this.ui.note(`Profile: ${arg}`); return; }
    if (command === 'cost') {
      const u = this.session.totals; const cached = u.input + u.cacheRead ? Math.round(u.cacheRead / (u.input + u.cacheRead) * 100) : 0;
      this.ui.note(`${u.requests} requests · ${u.input.toLocaleString()} input · ${u.output.toLocaleString()} output · ${u.cacheRead.toLocaleString()} cache read (${cached}%)\nEstimated catalog cost: $${u.cost.toFixed(5)}. Subscription quotas, tiered pricing and unknown/custom prices are not measured.`); return;
    }
    if (command === 'status') { this.ui.note(JSON.stringify({ session: this.session.meta.id, cwd: this.session.meta.cwd, status: this.session.status, model: this.engine.config.model, effort: this.engine.config.effort, profile: this.engine.config.profile, budget: this.engine.config.budget || 'unlimited', maxSteps: this.engine.config.maxSteps || 'unlimited', access: 'full host access, no approval prompts', objective: this.session.state.loopGoal || null }, null, 2)); return; }
    if (command === 'loop') { if (!arg) throw new Error('Usage: /loop <objective>'); this.ui.user(arg); await this.engine.run(arg, { loop: true }).catch(() => {}); return; }
    if (command === 'continue') { await this.engine.run(arg || 'Continue the pending task from the recorded progress.').catch(() => {}); return; }
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
    if (command === 'jobs') {
      const [action, id] = arg.split(/\s+/);
      if (action === 'stop') { if (!id) throw new Error('Usage: /jobs stop <id>'); this.ui.note(JSON.stringify(await this.jobs.stop(id), null, 2)); return; }
      if (action) { this.ui.note(JSON.stringify(await this.jobs.get(action), null, 2) + '\n' + await this.jobs.tail(action)); return; }
      const jobs = await this.jobs.list(); this.ui.note(jobs.length ? jobs.map(j => `${j.id} · ${j.status} · ${j.label}\n${j.log}`).join('\n\n') : 'No background jobs.'); return;
    }
    if (command === 'refresh') { this.ui.note('Refreshing model catalog…'); const result = await this.registry.refresh(arg || this.engine.model.provider); this.ui.note(result.errors.size ? [...result.errors].map(([p, e]) => `${p}: ${e.message}`).join('\n') : 'Provider catalog refreshed.'); return; }
    if (command === 'export') { const path = resolve(this.session.meta.cwd, arg || `psi-${this.session.meta.id}.md`); await writeFile(path, this.exportMarkdown(), { mode: 0o600 }); this.ui.note(`Exported: ${path}`); return; }
    throw new Error(`Unknown command: /${command}. Use /help.`);
  }
  exportMarkdown() {
    return `# Ψ Psi session\n\nWorkspace: ${this.session.meta.cwd}\nSession: ${this.session.meta.id}\n\n` + this.session.messages.map(m => {
      const content = typeof m.content === 'string' ? m.content : m.content.map(c => c.type === 'text' ? c.text : c.type === 'toolCall' ? `Tool: ${c.name}\n\n${JSON.stringify(c.arguments)}` : c.type === 'image' ? '[Image]' : '').join('\n');
      return `## ${m.role}${m.toolName ? `: ${m.toolName}` : ''}\n\n${redact(content)}\n`;
    }).join('\n');
  }
  async close() {
    if (this.closing) return; this.closing = true;
    this.authController?.abort(); this.engine.stop(); this.ui?.stop(); await this.tools.close(); this.options.onClose?.();
  }
}
