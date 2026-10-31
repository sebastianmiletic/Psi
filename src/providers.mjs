import { readFileSync } from 'node:fs';
import { createModels, createProvider, envApiKeyAuth, lazyApi } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Accounts } from './accounts.mjs';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const apis = {
  'openai-completions': lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  'openai-responses': lazyApi(() => import('@earendil-works/pi-ai/api/openai-responses')),
  'anthropic-messages': lazyApi(() => import('@earendil-works/pi-ai/api/anthropic-messages')),
};
export class Registry {
  constructor(config, home) {
    this.accounts = new Accounts(home);
    this.models = builtinModels({ credentials: this.accounts.store(), identity: { version: '0.1.0' } });
    this.config=config;
    this.catalogDate = catalog.fetchedAt;
    this.unavailable = [];
    for (const p of catalog.providers) {
      if (this.models.getProvider(p.id)) continue;
      const api = p.npm === '@ai-sdk/anthropic' ? 'anthropic-messages' : ['@ai-sdk/openai-compatible', '@ai-sdk/openai'].includes(p.npm) ? 'openai-completions' : null;
      if (api && /^https?:\/\//.test(p.api || '') && !p.api.includes('${') && p.models.length) this.register({ ...p, baseUrl: p.api, api });
      else this.unavailable.push({ id: p.id, name: p.name, doc: p.doc });
    }
    this.register({ id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', keyless: true, models: [] });
    this.register({ id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', keyless: true, models: [] });
    for (const p of config.customProviders || []) this.register(p);
    this.applyPrices(config.customPrices || {});
  }
  register(p) {
    if (!p.id || !p.baseUrl) throw new Error('Custom providers require id and baseUrl.');
    const endpoint = new URL(p.baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Provider URL must use HTTP or HTTPS.');
    const api = p.api || 'openai-completions';
    if (!apis[api]) throw new Error(`Unsupported API: ${api}`);
    const provider = createProvider({
      id: p.id, name: p.name || p.id, baseUrl: p.baseUrl,
      auth: { apiKey: p.keyless ? {
        name: 'Local server', resolve: async () => ({ auth: { apiKey: 'local' }, source: 'local server' }),
      } : envApiKeyAuth(`${p.name || p.id} API key`, p.env || []) },
      models: (p.models || []).map(m => ({
        name: m.id, input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...m,
        api, provider: p.id, baseUrl: p.baseUrl,
      })), api: apis[api],
    });
    this.models.setProvider(provider);
  }
  billingMode(account) {return account.type==='oauth'&&(this.models.getProvider(account.provider)?.auth.oauth?.isSubscription===true||['openai','openai-codex','anthropic','github-copilot'].includes(account.provider))?'subscription':'metered';}
  applyPrices(prices) {
    this.config.customPrices=prices;for(const model of this.all()){const p=prices[`${model.provider}/${model.id}`];if(p)model.cost={...model.cost,...p};}
  }
  pricesKnown(model) { return !!this.config.customPrices?.[`${model.provider}/${model.id}`] || Object.values(model.cost).some(n=>n>0) || /:free$/.test(model.id) || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(model.baseUrl); }
  forAccount(account) {
    const models = createModels({ credentials: this.accounts.store(account), identity: { version: '0.1.0' } });
    for (const entry of this.models.getProviders()) models.setProvider(entry);
    return models;
  }
  async forRequest(provider, selected) {
    const account = selected || await this.accounts.selected(provider);
    return { account, models: this.forAccount(account) };
  }
  all() { return this.models.getModels(); }
  find(value) {
    const i = value.indexOf('/');
    if (i > 0) { const m = this.models.getModel(value.slice(0, i), value.slice(i + 1)); if (m) return m; }
    const matches = this.all().filter(m => m.id === value);
    if (matches.length === 1) return matches[0];
    throw new Error(matches.length ? `Use provider/model to select ${value}.` : `Model not found: ${value}. Use /model to search.`);
  }
  async refresh(provider, signal) { return this.models.refresh({ providers: provider ? [provider] : undefined, signal, force: true }); }
}
