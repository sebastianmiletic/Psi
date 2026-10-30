import { writeFile } from 'node:fs/promises';
const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
const source = await response.json();
const providers = Object.values(source).map(p => ({
  id: p.id, name: p.name, api: p.api, npm: p.npm, env: p.env || [], doc: p.doc,
  models: Object.values(p.models || {}).filter(m => m.tool_call && m.modalities?.output?.includes('text')).map(m => ({
    id: m.id, name: m.name, reasoning: !!m.reasoning,
    input: m.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: m.limit?.context || 32000, maxTokens: m.limit?.output || 4096,
    cost: { input: m.cost?.input || 0, output: m.cost?.output || 0, cacheRead: m.cost?.cache_read || 0, cacheWrite: m.cost?.cache_write || 0 },
  })),
}));
await writeFile(new URL('../data/catalog.json', import.meta.url), JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'https://models.dev/api.json', providers }));
console.log(`Saved ${providers.length} providers, ${providers.reduce((n, p) => n + p.models.length, 0)} tool-capable models.`);
