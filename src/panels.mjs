import { matchesKey,truncateToWidth,visibleWidth } from '@earendil-works/pi-tui';
import { compactCount } from './usage.mjs';
import { formatDuration,dayKey } from './stats.mjs';
import { cleanTerminal,redact } from './storage.mjs';
import { accentBadge,accentText } from './theme.mjs';
const dim=s=>`\x1b[2m${s}\x1b[22m`,bold=s=>`\x1b[1m${s}\x1b[22m`,safe=s=>cleanTerminal(redact(s));
const row=(text,width)=>truncateToWidth('  '+text,width);
const hints='← →  tab · ↵ · esc';

export class EffortPanel {
 focused=true;
 constructor(ui,{levels,effort,overkill,resolve,cancel}){
  this.ui=ui;this.levels=levels.filter(l=>l!=='minimal');if(!this.levels.length)this.levels=levels;
  this.index=Math.max(0,this.levels.indexOf(effort));this.overkill=overkill;this.resolve=resolve;this.cancel=cancel;this.publish();
 }
 publish(){this.ui.effortPreview={effort:this.levels[this.index],overkill:this.overkill};this.ui.syncMotion();this.ui.render();}
 invalidate(){}
 render(width){
  const paint=this.ui.paint,cell=Math.floor((Math.min(78,width)-4)/this.levels.length),horizontal=cell>=6;
  const labels=this.levels.map((v,i)=>i===this.index?paint(bold(v)):dim(v));
  const track=this.levels.map((_,i)=>i===this.index?paint('●'):dim('○')).join('━');
  const scale=horizontal?[
   labels.map((v,i)=>v+' '.repeat(Math.max(0,cell-visibleWidth(this.levels[i])))).join(''),
   this.levels.map((_,i)=>(i===this.index?paint('●'):dim('○'))+dim('─'.repeat(Math.max(0,cell-1)))).join('')
  ]:[paint(bold('← '+this.levels[this.index]+' →'))+'  '+track];
  return [row(bold('Effort'),width),...scale.map(s=>row(s,width)),row(this.overkill?accentBadge(' OVERKILL ON ',this.ui.app.engine.config):dim('○ OVERKILL'),width),row(dim(hints),width)];
 }
 handleInput(data){
  if(matchesKey(data,'escape')){this.cancel();return;}
  if(matchesKey(data,'enter')){this.resolve({effort:this.levels[this.index],overkill:this.overkill});return;}
  if(matchesKey(data,'tab'))this.overkill=!this.overkill;
  else if(matchesKey(data,'left')||matchesKey(data,'down'))this.index=Math.max(0,this.index-1);
  else if(matchesKey(data,'right')||matchesKey(data,'up'))this.index=Math.min(this.levels.length-1,this.index+1);
  else if(matchesKey(data,'home'))this.index=0;else if(matchesKey(data,'end'))this.index=this.levels.length-1;
  this.publish();
 }
}

// A calendar grid, with seven days per column. Future/out-of-period days remain blank.
export function heatmap(s,weeks,paint){
 const end=new Date(s.now);end.setHours(0,0,0,0);const start=new Date(end);start.setDate(start.getDate()-(start.getDay()+6)%7-(weeks-1)*7);
 const max=Math.max(1,...Object.values(s.days));const lines=[];
 for(let day=0;day<7;day++){
  let line=dim(['M',' ','W',' ','F',' ','S'][day])+' ';
  for(let week=0;week<weeks;week++){
   const d=new Date(start);d.setDate(d.getDate()+week*7+day);const value=s.days[dayKey(d)]||0;
   if(d>end||+d<(s.start||0))line+='  ';
   else if(!value)line+=dim('▪ ');
   else line+=paint(['░ ','▒ ','▓ ','█ '][Math.min(3,Math.floor(value/max*3))]);
  }
  lines.push(line);
 }
 return lines;
}
export class StatsPanel {
 focused=true;
 constructor(ui,{data=null,cancel,refresh}){this.ui=ui;this.data=data;this.index=2;this.cancel=cancel;this.refresh=refresh;this.loading=false;if(!data)void this.load();}
 async load(){if(this.loading)return;this.loading=true;this.error=null;try{this.data=await this.refresh();}catch(e){this.error=e.message;}finally{this.loading=false;this.ui.render();}}
 invalidate(){}
 render(width){
  const paint=this.ui.paint,budget=this.ui.panelRows(),wide=width>=72;
  const tabs=['Week','Month','All'].map((v,i)=>i===this.index?paint(bold('['+v+']')):dim(v)).join('  ');
  const lines=[bold('Stats')+' · '+tabs];
  if(!this.data){lines.push(this.error?safe(this.error):dim('…'),dim('esc'));return lines.map(s=>row(s,width));}
  const s=this.data[this.index];
  if(wide){
   lines.push(`Tokens ${bold(compactCount(s.tokens))} · Time ${bold(formatDuration(s.activeMs))} · Calls ${bold(compactCount(s.requests))}`,
    `Sessions ${s.sessions}  ·  Workers ${s.workers}  ·  Tools ${compactCount(s.tools)}  ·  Goals ${s.goals}`,
    dim(`In ${compactCount(s.input)}  Out ${compactCount(s.output)}  Cache ${s.cachePercent}%`));
  }else lines.push(`${bold(compactCount(s.tokens))} tokens · ${bold(formatDuration(s.activeMs))}`,
    `${compactCount(s.requests)} calls · ${s.sessions} sessions`,`${s.workers} workers · ${compactCount(s.tools)} tools`);
  const weeks=Math.max(2,Math.min(16,Math.floor((width-7)/2))),chart=heatmap(s,weeks,paint);
  if(budget>=13){lines.push('',...chart);}
  else if(budget>=7){
   const cells=[];for(let i=weeks*7-1;i>=0;i--){const d=new Date(s.now);d.setDate(d.getDate()-i);cells.push(s.days[dayKey(d)]||0);}
   const max=Math.max(1,...cells),points=Math.max(1,Math.min(width-4,cells.length));
   lines.push(cells.slice(-points).map(n=>n?paint(['▂','▄','▆','█'][Math.min(3,Math.floor(n/max*3))]):dim('·')).join(''));
  }
  if(this.error)lines.push(dim('Refresh failed'));
  else if(s.unknownDatedRequests||s.malformed)lines.push(dim('Partial history'));
  lines.push(dim(this.loading?'…':'← →  tab · r ↻ · esc'));
  const body=lines.length>budget?[...lines.slice(0,budget-1),lines.at(-1)]:lines;
  return body.map(s=>row(s,width));
 }
 handleInput(data){
  if(matchesKey(data,'escape')||matchesKey(data,'enter')){this.cancel();return;}
  if(matchesKey(data,'left'))this.index=(this.index+2)%3;else if(matchesKey(data,'right')||matchesKey(data,'tab'))this.index=(this.index+1)%3;
  else if(data==='r'&&!this.loading)void this.load();this.ui.render();
 }
}
export class ToolsPanel {
 focused=true;
 constructor(ui,{tools,cancel}){this.ui=ui;this.tools=tools;this.cancel=cancel;this.page=0;}
 invalidate(){}
 render(width){
  const slot=Math.min(width-4,Math.max(18,...this.tools.map(t=>t.name.length))+2),columns=Math.max(1,Math.floor((width-4)/slot)),cell=Math.floor((width-4)/columns),rows=Math.max(1,Math.min(8,this.ui.panelRows()-2));
  this.pageSize=rows*columns;this.pages=Math.max(1,Math.ceil(this.tools.length/this.pageSize));this.page%=this.pages;
  const tools=this.tools.slice(this.page*this.pageSize,(this.page+1)*this.pageSize),lines=[bold('Tools')+dim(`  ${this.tools.length}${this.pages>1?' · '+(this.page+1)+'/'+this.pages:''}`)];
  for(let i=0;i<tools.length;i+=columns)lines.push(tools.slice(i,i+columns).map(t=>this.ui.paint(truncateToWidth(t.name,cell-1))+' '.repeat(Math.max(1,cell-visibleWidth(truncateToWidth(t.name,cell-1))))).join(''));
  lines.push(dim(this.pages>1?'← → · esc':'esc'));return lines.map(s=>row(s,width));
 }
 handleInput(data){if(matchesKey(data,'escape')||matchesKey(data,'enter'))this.cancel();else if(matchesKey(data,'right')||matchesKey(data,'tab'))this.page=(this.page+1)%(this.pages||1);else if(matchesKey(data,'left'))this.page=(this.page+(this.pages||1)-1)%(this.pages||1);this.ui.render();}
}

export function resetTime(seconds,now=Date.now(),compact=false){
 if(!Number.isFinite(seconds)||seconds<=0)return 'time not reported';
 const left=seconds*1000-now;if(left<=0)return 'refresh due';
 const minutes=Math.ceil(left/60000),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
 const countdown=days?`${days}d ${hours%24}h`:hours?`${hours}h ${minutes%60}m`:`${minutes}m`;
 const date=new Intl.DateTimeFormat(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit',...(compact?{}:{month:'short',day:'numeric',timeZoneName:'short'})}).format(new Date(seconds*1000));
 return `${date} · ${countdown}`;
}
export class ResetPanel {
 focused=true;
 constructor(ui,{account,read,use,onUsage=()=>{},resolve,cancel,now=()=>Date.now()}){
  Object.assign(this,{ui,account,read,use,onUsage,resolve,cancel,now});this.controller=new AbortController();this.loading=false;this.confirm=false;this.closed=false;
  this.timer=setInterval(()=>{if(!this.closed)this.ui.render();},15000);this.timer.unref();void this.load();
 }
 dispose(){this.closed=true;clearInterval(this.timer);this.controller.abort();}
 invalidate(){}
 async load(){if(this.loading||this.closed)return;this.loading=true;this.confirm=false;this.error=null;try{const data=await this.read(this.controller.signal);if(!this.closed){this.data=data;this.onUsage(data);}}catch{if(!this.closed)this.error='Usage unavailable';}finally{this.loading=false;if(!this.closed)this.ui.render();}}
 async redeem(){
  if(this.loading||this.closed)return;this.loading=true;this.confirm=false;this.error=null;this.ui.render();
  try{const data=await this.use(this.controller.signal);if(!this.closed){this.data=data;this.onUsage(data);this.notice={reset:'Reset used',alreadyRedeemed:'Reset already used',nothingToReset:'No eligible limit',noCredit:'No resets available'}[data.outcome]||'';}}
  catch{if(!this.closed){this.error='Reset unconfirmed · r to check';await this.loadAfterFailure();}}
  finally{this.loading=false;if(!this.closed)this.ui.render();}
 }
 async loadAfterFailure(){try{const data=await this.read(this.controller.signal);if(!this.closed){this.data=data;this.onUsage(data);}}catch{/* Pending intent remains available for the next read. */}}
 render(width){
  const paint=this.ui.paint,compact=width<72,budget=this.ui.panelRows(),data=this.data;
  const lines=[bold('Reset')+' · '+safe(this.account.name||this.account.provider)];
  if(!data){lines.push(dim(this.error||'…'),dim('a accounts · esc'));return lines.map(s=>row(s,width));}
  const windows=(data.usage?.limits||[]).filter(l=>l.kind==='quota').sort((a,b)=>(a.label==='5h'?0:1)-(b.label==='5h'?0:1));
  for(const l of windows.slice(0,3)){
   const label=['7d','1w','weekly'].includes(l.label)?'Week':safe(l.label),expired=l.resetAt&&l.resetAt*1000<=this.now();
   const pct=expired?'—':`${100-Math.round(l.usedPercent)}%`;
   lines.push(`${paint(label.padEnd(5))}${bold(pct)} · ${dim(resetTime(l.resetAt,this.now(),compact))}`);
  }
  if(!windows.length)lines.push(dim(data.mode==='none'?'No subscription limits':'Limits not reported'));
  if(data.mode==='codex'){
   lines.push(`Resets ${data.credits?bold(String(data.credits.availableCount)):dim('not reported')}`);
   const expiry=(data.credits?.credits||[]).filter(c=>c.status==='available'&&c.expiresAt&&c.expiresAt*1000>this.now()).sort((a,b)=>a.expiresAt-b.expiresAt)[0]?.expiresAt;
   if(expiry&&budget>=8)lines.push(dim('Expires '+resetTime(expiry,this.now(),compact)));
  }
  const canUse=data.mode==='codex'&&(data.pending||data.credits?.availableCount>0)&&!data.error;
  // A saved uncertain redemption can be retried with its original idempotency key.
  const canRetry=data.mode==='codex'&&data.pending;
  const actionIndex=lines.length;
  if(this.confirm)lines.push(paint(bold('Use 1 reset? ↵ confirm')));
  else if(canUse||canRetry)lines.push(paint(bold(data.pending?'↵ Retry pending reset':'↵ Use 1 reset')));
  else if(data.mode==='claude')lines.push(paint('o Redeem on Claude Usage'));
  else if(data.mode==='codex'&&data.error)lines.push(dim(safe(data.error)));
  else if(data.mode==='codex')lines.push(dim('No available reset'));
  if(this.notice||this.error)lines.push(dim(this.notice||this.error));
  lines.push(dim(this.loading?'…':compact?'r ↻ · a · o · esc':data.mode==='none'?'r ↻ · a accounts · esc':'r ↻ · a accounts · o web · esc'));
  const body=lines.length>budget?[...lines.slice(0,budget-2),lines[actionIndex]||'',lines.at(-1)]:lines;return body.map(s=>row(s,width));
 }
 handleInput(data){
  if(matchesKey(data,'escape')){this.cancel();return;}
  if(this.loading)return;
  if(data==='a'){this.resolve('accounts');return;}
  if(data==='o'&&['codex','claude'].includes(this.data?.mode)){this.resolve('web');return;}
  if(data==='r'){void this.load();return;}
  if(matchesKey(data,'enter')&&this.data?.mode==='codex'&&(this.data.pending||this.data.credits?.availableCount>0)){
   if(this.confirm)void this.redeem();else this.confirm=true;
  }
  this.ui.render();
 }
}
