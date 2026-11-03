import { open, readdir, stat,rm,rmdir,appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {compactJournal,journalInfo,journalLines,SEGMENT_BYTES,compressFile,syncDirectory} from './journal.mjs';
import {TranscriptHistory} from './transcript-history.mjs';
import { privateDir, atomicJSON,cleanTerminal, readJSON, psiHome, withLock, alive } from './storage.mjs';

const meaningful=m=>!m?.internal&&['user','assistant'].includes(m?.role)&&(typeof m.content==='string'?!!m.content.trim():Array.isArray(m.content)&&m.content.some(c=>c.type==='image'||c.type==='text'&&c.text?.trim()));
const titled=meta=>typeof meta.title==='string'&&!!meta.title.trim()&&(meta.title!=='New session'||meta.named||meta.autoNamed||meta.seedNamed);

export class Session {
  constructor(home, meta) {
    this.home = home; this.meta = meta; this.dir = Session.path(home,meta.id,meta.parentSession);
    this.messages = []; this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
    this.conversation = [];
    this.accountTotals = {}; this.meteredCost = 0; this.meteredCostKnown = true;
    this.seenUsage=new Set();
    this.state = {}; this.status = 'idle'; this.journalSize = 0; this.writeChain=Promise.resolve();
    this.debugChain=Promise.resolve();this.streaming=null;this.transcript=new TranscriptHistory();
  }
  static path(home,id,parentSession){
    if(!/^(?!\.{1,2}$)[\w.-]+$/.test(id)||parentSession&&!/^(?!\.{1,2}$)[\w.-]+$/.test(parentSession))throw new Error('Invalid session ID.');
    return parentSession?join(home,'sessions',parentSession,'agents',id):join(home,'sessions',id);
  }
  static async create(cwd, home = psiHome(), {parentSession}={}) {
    const meta = { id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, cwd: resolve(cwd), createdAt: new Date().toISOString(), title: 'New session',draft:true,hasMessages:false,...(parentSession?{parentSession}:{}) };
    const session = new Session(home, meta);
    await privateDir(session.dir); await atomicJSON(join(session.dir, 'meta.json'), meta); return session;
  }
  static async load(id, home = psiHome(), {parentSession}={}) {
    if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid session ID.');
    let dir=Session.path(home,id,parentSession);
    if(parentSession&&!await stat(join(dir,'meta.json')).catch(()=>null))dir=Session.path(home,id);
    return withLock(join(dir, 'run.lock'), async () => {
      const meta = await readJSON(join(dir,'meta.json'), null);
      if (!meta) throw new Error(`Session not found: ${id}`);
      const session = new Session(home, meta);
      session.dir=dir;
      session.journalSize = (await compactJournal(session.dir,{repair:true})).size;
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
      await session.saveMeta();
      return session;
    }, { timeout: 500 });
  }
  async *events() { for await(const {line} of journalLines(this.dir))if(line)yield JSON.parse(line); }
  async debug(data){
    const next=this.debugChain.then(async()=>{
      const dir=join(this.dir,'diagnostics');await privateDir(dir);
      const path=join(dir,'events.jsonl');await appendFile(path,JSON.stringify(data)+'\n',{mode:0o600});
      if((await stat(path)).size>=SEGMENT_BYTES)await compactJournal(dir);
    });this.debugChain=next.catch(()=>{});return next;
  }
  async compactStorage(){
    await this.debugChain;
    return this.enqueue(()=>withLock(join(this.dir,'run.lock'),async()=>{
      const info=await compactJournal(this.dir,{force:true});
      if(await stat(join(this.dir,'diagnostics')).catch(()=>null))await compactJournal(join(this.dir,'diagnostics'),{force:true});
      if(await stat(join(this.dir,'debug.jsonl')).catch(()=>null))await compressFile(join(this.dir,'debug.jsonl'));
      return info;
    },{timeout:0}).catch(error=>{if(/Another Psi process holds/.test(error.message))return{skipped:true};throw error;}));
  }
  enqueue(fn) {const next=this.writeChain.then(fn);this.writeChain=next.catch(()=>{});return next;}
  async assertLatest() {
    return this.enqueue(async()=>{
      const {size}=await journalInfo(this.dir);
      if(size!==this.journalSize)throw new Error('This session changed in another Psi process. Resume it again before continuing.');
    });
  }
  apply(event) {
    if(event.type==='stream_start')this.streaming={requestId:event.requestId,text:'',timestamp:Date.parse(event.at)||Date.now(),partial:true};
    if(event.type==='stream_delta'){
      if(this.streaming?.requestId!==event.requestId)this.streaming={requestId:event.requestId,text:'',timestamp:Date.parse(event.at)||Date.now(),partial:true};
      this.streaming.text+=event.text;
    }
    if(event.type==='stream_end'&&this.streaming?.requestId===event.requestId){
      if(['error','aborted'].includes(event.outcome)){if(this.streaming.text)this.rememberVisible({role:'assistant',partial:true,content:[{type:'text',text:this.streaming.text}],timestamp:this.streaming.timestamp});this.streaming=null;}
    }
    if (event.type === 'message') {
      if(event.requestId&&this.streaming?.requestId===event.requestId)this.streaming=null;
      this.messages.push(event.message);
      const m=event.message;
      if(meaningful(m))this.meta.hasMessages=true;
      if(m.role==='user'&&meaningful(m)&&this.meta.title==='New session'&&!this.meta.named&&!this.meta.seedNamed){this.meta.seedNamed=true;this.meta.title=cleanTerminal(typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(' ')).replace(/\s+/g,' ').trim().slice(0,100)||'Attached content';}
      if(!m.internal&&(m.role==='user'||m.role==='assistant'&&(typeof m.content==='string'?m.content.trim():m.content.some(c=>c.type==='text'&&c.text.trim()))))this.rememberVisible(m);
    }
    if(event.type==='final_response'){
      if(event.text?.trim())this.meta.hasMessages=true;
      this.rememberVisible({role:'assistant',content:[{type:'text',text:event.text}],timestamp:event.timestamp||Date.parse(event.at),finalReview:true});
      if(event.completionId)this.state.reviewedCompletionId=event.completionId;
    }
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
    if(event.type==='session_name'){this.meta.title=event.name;this.meta.named=true;}
    if(event.type==='session_auto_name'&&!this.meta.named){this.meta.title=event.name;this.meta.autoNamed=true;}
    if(event.type==='session_directory'){this.meta.cwd=event.cwd;if(event.directories)this.state.directories=event.directories;}
    if (event.type === 'state') Object.assign(this.state, event.state);
    if(event.type==='request_metrics')this.state.requestPrefixes={...this.state.requestPrefixes,[event.route+':'+event.purpose]:event.prefixHash};
    if (event.type === 'status') this.status = event.status;
    this.transcript.observe(event,this.state);
  }
  async event(event) {
    return this.enqueue(async()=>{
      const line=JSON.stringify({...event,at:new Date().toISOString()})+'\n';
      await this.appendDurable(line);this.apply(event);
    });
  }
  async appendDurable(line){
    const handle=await open(join(this.dir,'events.jsonl'),'a',0o600);
    let size;
    try{await handle.writeFile(line);await handle.sync();this.journalSize+=Buffer.byteLength(line);size=(await handle.stat()).size;}
    finally{await handle.close();}
    if(size===Buffer.byteLength(line))await syncDirectory(this.dir);
    if(size>=SEGMENT_BYTES)await compactJournal(this.dir).catch(error=>{this.storageError=error;});
  }
  async flush(){await this.writeChain;}
  async markActive(){if(!this.meta.parentSession&&this.meta.hasMessages)await atomicJSON(join(this.home,'last-session.json'),{id:this.meta.id,cwd:this.meta.cwd,at:new Date().toISOString()});}
  visibleConversation(){return this.streaming?.text?[...this.conversation,{role:'assistant',partial:true,content:[{type:'text',text:this.streaming.text}],timestamp:this.streaming.timestamp}]:this.conversation;}
  transcriptView(){return this.transcript.view(this.streaming);}
  rememberVisible(message){this.transcript.message(message);this.conversation.push(message);if(this.conversation.length>100)this.conversation.shift();}
  async saveMeta(){this.meta.draft=!(this.meta.hasMessages&&titled(this.meta));await atomicJSON(join(this.dir,'meta.json'),this.meta);}
  async message(message,{requestId}={}) {
    const hadMessages=this.meta.hasMessages;
    await this.event({ type: 'message', message,...(requestId?{requestId}:{}) });
    if (message.role === 'user'&&!message.internal && this.meta.title === 'New session'&&!this.meta.named&&!this.meta.seedNamed) {
      await this.enqueue(async()=>{if(this.meta.named||this.meta.seedNamed||this.meta.title!=='New session')return;this.meta.seedNamed=true;this.meta.title=cleanTerminal(typeof message.content==='string'?message.content:message.content.filter(c=>c.type==='text').map(c=>c.text).join(' ')).replace(/\s+/g,' ').trim().slice(0,100)||'Attached content';await this.saveMeta();});
    }
    else if(!hadMessages&&this.meta.hasMessages)await this.enqueue(()=>this.saveMeta());
    if(meaningful(message))await this.markActive();
  }
  async rename(name,{duringRun=false}={}){
    const title=cleanTerminal(name).replace(/\s+/g,' ').trim();if(!title)throw new Error('Enter a session name.');if(Array.from(title).length>120)throw new Error('Session names can be up to 120 characters.');
    const save=async()=>{await this.assertLatest();await this.event({type:'session_name',name:title});await this.enqueue(()=>this.saveMeta());return title;};
    return duringRun?save():withLock(join(this.dir,'run.lock'),save,{timeout:500});
  }
  async autoName(name){
    const title=cleanTerminal(name).replace(/\s+/g,' ').trim();if(!title||Array.from(title).length>80)throw new Error('Use a short title, up to 80 characters.');
    // Journal and snapshot share a queue slot so a manual rename always wins.
    return this.enqueue(async()=>{
      if(this.meta.named||this.meta.autoNamed)return false;
      const event={type:'session_auto_name',name:title,at:new Date().toISOString()},line=JSON.stringify(event)+'\n';
      await this.appendDurable(line);this.apply(event);
      await this.saveMeta();return true;
    });
  }
  async directory(cwd,roots){
    return withLock(join(this.dir,'run.lock'),async()=>{await this.assertLatest();await this.event({type:'session_directory',cwd,directories:roots});await this.enqueue(()=>this.saveMeta());},{timeout:500});
  }
  async discardEmpty(){
    await this.writeChain;
    if(!await stat(join(this.dir,'meta.json')).catch(()=>null))return false;
    const removed=await withLock(join(this.dir,'run.lock'),async()=>{
      const ui=join(this.dir,'ui.lock');if(await stat(ui).catch(()=>null)){const owner=await readJSON(ui,null).catch(()=>null);if(!owner?.pid||alive(owner.pid))return false;}
      const meta=await readJSON(join(this.dir,'meta.json'),null);if(!meta||meta.hasMessages)return false;
      for await(const e of this.events())if(e.type==='message'&&meaningful(e.message)||e.type==='final_response'&&e.text?.trim()||e.type==='usage'||e.type==='state'&&(e.state?.queuedMessages?.length||e.state?.loopGoal||e.state?.agents?.length))return false;
      // Keep our open lock until its handle closes, including on Windows.
      for(const name of await readdir(this.dir))if(name!=='run.lock')await rm(join(this.dir,name),{recursive:true,force:true,maxRetries:5,retryDelay:20});
      return true;
    },{timeout:0}).catch(e=>{if(/Another Psi process holds/.test(e.message))return false;throw e;});
    if(removed)await rmdir(this.dir).catch(e=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;});return removed;
  }
  static async list(home = psiHome()) {
    const names = (await readdir(join(home, 'sessions'),{withFileTypes:true}).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).filter(e=>e.isDirectory()).map(e=>e.name);
    const data = await Promise.all(names.map(async n=>{
      const meta=await readJSON(join(home,'sessions',n,'meta.json'),null);if(!meta||meta.parentSession||await stat(join(home,'sessions',n,'worker.json')).catch(()=>null))return null;
      const journal=await journalInfo(join(home,'sessions',n)),updatedAt=new Date(journal.mtimeMs||Date.parse(meta.createdAt)||0).toISOString();
      if(meta.hasMessages&&titled(meta))return{...meta,updatedAt};
      // Read old snapshots or a first message committed just before a crash.
      for await(const e of new Session(home,meta).events())if(e.type==='message'&&meaningful(e.message)||e.type==='final_response'&&e.text?.trim()){const title=titled(meta)?meta.title:cleanTerminal(typeof e.message?.content==='string'?e.message.content:e.text||'Recovered session').replace(/\s+/g,' ').trim().slice(0,100);return{...meta,title,hasMessages:true,draft:false,updatedAt};}
      return null;
    }));
    return data.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id));
  }
  static async storageEntries(home=psiHome()){
    const entries=[];
    for(const {name:id} of (await readdir(join(home,'sessions'),{withFileTypes:true}).catch(()=>[])).filter(e=>e.isDirectory())){
      if(!/^[\w.-]+$/.test(id))continue;
      const dir=Session.path(home,id),meta=await readJSON(join(dir,'meta.json'),null);if(!meta)continue;
      entries.push({id,dir,meta});
      for(const {name:worker} of (await readdir(join(dir,'agents'),{withFileTypes:true}).catch(()=>[])).filter(e=>e.isDirectory())){
        if(!/^[\w.-]+$/.test(worker)||worker.includes('.migrating-'))continue;
        const path=Session.path(home,worker,id),child=await readJSON(join(path,'meta.json'),null);if(child?.id===worker)entries.push({id:worker,dir:path,meta:child});
      }
    }
    return entries;
  }
}
