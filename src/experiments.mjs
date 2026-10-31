import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, readJSON, withLock, privateDir, psiHome } from './storage.mjs';

export class Experiments {
  constructor(home=psiHome()) { this.dir=join(home,'experiments'); }
  path(id) { if(!/^[\w-]+$/.test(id || ''))throw new Error('Invalid experiment ID');return join(this.dir,id); }
  async create(spec) {
    const id=`${Date.now().toString(36)}-${randomUUID().slice(0,8)}`,dir=this.path(id);await privateDir(dir);
    const data={schema:1,id,createdAt:new Date().toISOString(),revision:0,phase:'created',operations:{},panels:[],...spec};
    await atomicJSON(join(dir,'experiment.json'),data);return data;
  }
  async get(id) { const d=await readJSON(join(this.path(id),'experiment.json'),null);if(!d||d.schema!==1||d.id!==id)throw new Error('Experiment missing or unsupported schema');return d; }
  async update(id,event,fn) {
    return withLock(join(this.path(id),'state.lock'),async()=>{
      const d=await this.get(id);await fn(d);d.revision++;d.updatedAt=new Date().toISOString();
      // The snapshot is authoritative; the audit trail records committed revisions only.
      await atomicJSON(join(this.path(id),'experiment.json'),d);
      await appendFile(join(this.path(id),'events.jsonl'),JSON.stringify({revision:d.revision,event,at:d.updatedAt})+'\n',{mode:0o600});return d;
    });
  }
  async list(project) {
    const names=await readdir(this.dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const rows=await Promise.all(names.map(n=>this.get(n).catch(()=>null)));
    return rows.filter(d=>d&&(!project||d.project===project)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
}
