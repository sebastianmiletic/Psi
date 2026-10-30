import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJSON, atomicJSON, withLock, psiHome } from './storage.mjs';

export class Accounts {
  constructor(home = psiHome()) { this.home = home; this.path = join(home, 'accounts.json'); }
  async data() { return readJSON(this.path, { accounts: [], active: {} }); }
  async mutate(fn, options) {
    return withLock(join(this.home, 'accounts.lock'), async () => {
      const data = await this.data(); const result = await fn(data);
      await atomicJSON(this.path, data); return result;
    }, options);
  }
  async list() {
    const d = await this.data();
    return d.accounts.map(({ id, provider, name, credential, createdAt }) => ({ id, provider, name, type: credential.type, createdAt, active: d.active[provider] === id }));
  }
  async selected(provider) {
    const data = await this.data(); const a = data.accounts.find(a => a.provider === provider && a.id === data.active[provider]);
    return a ? { id: a.id, provider: a.provider, name: a.name, type: a.credential.type } : { id: `ambient:${provider}`, provider, name: 'Environment / local', type: 'ambient' };
  }
  async add(provider, name, credential) {
    if (!name?.trim()) throw new Error('Account name is required.');
    return this.mutate(d => {
      const account = { id: randomUUID(), provider, name: name.trim(), credential, createdAt: new Date().toISOString() };
      d.accounts.push(account); d.active[provider] = account.id; return account.id;
    });
  }
  async use(id) {
    return this.mutate(d => { const a = d.accounts.find(a => a.id === id); if (!a) throw new Error('Account not found.'); d.active[a.provider] = id; return a.provider; });
  }
  async remove(id) {
    return this.mutate(d => {
      const a = d.accounts.find(a => a.id === id); if (!a) throw new Error('Account not found.');
      d.accounts = d.accounts.filter(a => a.id !== id);
      if (d.active[a.provider] === id) {
        const other = d.accounts.find(x => x.provider === a.provider);
        if (other) d.active[a.provider] = other.id; else delete d.active[a.provider];
      }
    });
  }
  store(pinned) {
    const target = (data, provider) => pinned?.provider === provider ? (pinned.type === 'ambient' ? null : pinned.id) : data.active[provider];
    return {
      read: async (provider) => { const d = await this.data(); const a = d.accounts.find(a => a.id === target(d, provider) && a.provider === provider); if (pinned?.provider === provider && pinned.type !== 'ambient' && !a) throw new Error('The account selected for this request was removed.'); return a?.credential; },
      list: async () => (await this.list()).filter(a => a.active).map(a => ({ providerId: a.provider, type: a.type })),
      modify: async (provider, fn, options) => this.mutate(async d => {
        const a = d.accounts.find(a => a.id === target(d, provider) && a.provider === provider);
        const next = await fn(a?.credential);
        if (next && a) a.credential = next;
        else if (next) throw new Error('Add a named account before saving credentials.');
        return next || a?.credential;
      }, options),
      delete: async (provider, options) => this.mutate(d => {
        d.accounts = d.accounts.filter(a => a.id !== d.active[provider]); delete d.active[provider];
      }, options),
    };
  }
  async login(registry, providerId, name, type, interaction) {
    const p = registry.models.getProvider(providerId);
    if (!p) throw new Error(`Unknown provider: ${providerId}`);
    const auth = type === 'oauth' ? p.auth.oauth : p.auth.apiKey;
    if (!auth?.login) throw new Error(`This provider has no ${type} login. Configure its environment variables instead.`);
    const identityPath = join(this.home, 'device.json');
    const device = await withLock(join(this.home, 'device.lock'), async () => {
      const d = await readJSON(identityPath, { id: randomUUID() }); await atomicJSON(identityPath, d); return d;
    });
    const controller = new AbortController();
    const normalized = { ...interaction, signal: interaction.signal || controller.signal };
    const credential = await auth.login(normalized, { agentName: 'Psi', getDeviceId: () => device.id });
    return this.add(providerId, name, credential);
  }
}
