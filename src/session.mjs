import { appendFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, atomicJSON, readJSON, psiHome, withLock, durableJournalSize } from './storage.mjs';

export class Session {
  constructor(home, meta) {
    this.home = home; this.meta = meta; this.dir = join(home, 'sessions', meta.id);
    this.messages = []; this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
    this.accountTotals = {}; this.meteredCost = 0; this.meteredCostKnown = true;
    this.seenUsage=new Set();
    this.state = {}; this.status = 'idle'; this.journalSize = 0; this.writeChain=Promise.resolve();
  }
  static async create(cwd, home = psiHome()) {
    const meta = { id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, cwd: resolve(cwd), createdAt: new Date().toISOString(), title: 'New session' };
    const session = new Session(home, meta);
    await privateDir(session.dir); await atomicJSON(join(session.dir, 'meta.json'), meta); return session;
  }
  static async load(id, home = psiHome()) {
    if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid session ID.');
    return withLock(join(home, 'sessions', id, 'run.lock'), async () => {
      const meta = await readJSON(join(home, 'sessions', id, 'meta.json'), null);
      if (!meta) throw new Error(`Session not found: ${id}`);
      const session = new Session(home, meta);
      session.journalSize = await durableJournalSize(join(session.dir, 'events.jsonl'));
      let lineNumber = 0;
      for await (const line of session.events()) {
        lineNumber++;
        try { session.apply(line); }
        catch (e) { throw new Error(`Damaged session journal at event ${lineNumber}: ${e.message}`); }
      }
      // Resolve calls interrupted by a process crash, without repeating side effects.
      for (const m of [...session.messages]) {
        if (m.role !== 'assistant') continue;
        for (const call of m.content.filter(c => c.type === 'toolCall')) {
          if (!session.messages.some(r => r.role === 'toolResult' && r.toolCallId === call.id)) {
            await session.message({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'Psi was interrupted before recording this tool result. Inspect files or jobs before retrying; the action may have executed.' }], isError: true, timestamp: Date.now() });
          }
        }
      }
      if (session.status === 'running') await session.event({ type: 'status', status: 'interrupted' });
      return session;
    }, { timeout: 500 });
  }
  async *events() {
    if (!await stat(join(this.dir, 'events.jsonl')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) return;
    const input = createReadStream(join(this.dir, 'events.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) if (line) yield JSON.parse(line); }
    finally { lines.close(); input.destroy(); }
  }
  enqueue(fn) {const next=this.writeChain.then(fn);this.writeChain=next.catch(()=>{});return next;}
  async assertLatest() {
    return this.enqueue(async()=>{
      const size=await stat(join(this.dir,'events.jsonl')).then(s=>s.size).catch(e=>{if(e.code==='ENOENT')return 0;throw e;});
      if(size!==this.journalSize)throw new Error('This session changed in another Psi process. Resume it again before continuing.');
    });
  }
  apply(event) {
    if (event.type === 'message') this.messages.push(event.message);
    if (event.type === 'compact') this.messages = event.messages;
    if (event.type === 'usage') {
      if(event.requestId&&this.seenUsage.has(event.requestId))return;
      if(event.requestId)this.seenUsage.add(event.requestId);
      if(event.accountId) {
        const a=this.accountTotals[event.accountId] ||= {cost:0,requests:0,tokens:0};a.cost+=event.usage.cost?.total||0;a.requests++;a.tokens+=event.usage.totalTokens||0;
      }
      if(event.billing?.mode==='metered') {this.meteredCost+=event.usage.cost?.total||0;if(!event.billing.known)this.meteredCostKnown=false;}

      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) this.totals[k] += event.usage[k] || 0;
      this.totals.cost += event.usage.cost?.total || 0; this.totals.requests++;
    }
    if (event.type === 'state') Object.assign(this.state, event.state);
    if (event.type === 'status') this.status = event.status;
  }
  async event(event) {
    return this.enqueue(async()=>{
      const line=JSON.stringify({...event,at:new Date().toISOString()})+'\n';
      await appendFile(join(this.dir,'events.jsonl'),line,{mode:0o600});this.journalSize+=Buffer.byteLength(line);this.apply(event);
    });
  }
  async message(message) {
    await this.event({ type: 'message', message });
    if (message.role === 'user' && this.meta.title === 'New session') {
      this.meta.title = String(message.content).slice(0, 100); await atomicJSON(join(this.dir, 'meta.json'), this.meta);
    }
  }
  static async list(home = psiHome()) {
    const names = await readdir(join(home, 'sessions')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const data = await Promise.all(names.map(n => readJSON(join(home, 'sessions', n, 'meta.json'), null)));
    return data.filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
  }
}
