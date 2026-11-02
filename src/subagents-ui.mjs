import { cleanTerminal } from './storage.mjs';
export const activeWorker = worker => ['running', 'queued', 'waiting'].includes(worker.status);
export function workerGroups(workers) {
  const groups = new Map();
  for (const worker of workers.filter(activeWorker)) {
    const name = cleanTerminal(worker.group || 'Other tasks').replace(/\s+/g, ' ').trim();
    const key = name.normalize('NFKC').toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, workers: [] });
    groups.get(key).workers.push(worker);
  }
  return [...groups.values()];
}
// Bounded footer, unbounded active registry. Overflow counts include every worker.
export function workerDisplay(workers, maxRows = 3) {
  const active = workers.filter(activeWorker);
  if (!active.length) return [];
  const grouped = active.length > 3;
  const entries = grouped ? workerGroups(active) : active.map(worker => ({ name: worker.name, workers: [worker] }));
  const rows = entries.slice(0, Math.max(1, maxRows));
  const hidden = entries.slice(rows.length).reduce((n, g) => n + g.workers.length, 0);
  return rows.map((entry, i) => ({ ...entry, grouped, hidden: i === rows.length - 1 ? hidden : 0 }));
}
