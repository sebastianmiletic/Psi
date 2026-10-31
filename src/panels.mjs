import { matchesKey,truncateToWidth,visibleWidth } from '@earendil-works/pi-tui';
import { compactCount } from './usage.mjs';
import { formatDuration,dayKey } from './stats.mjs';
import { cleanTerminal,redact } from './storage.mjs';
const dim=s=>`\x1b[2m${s}\x1b[22m`,bold=s=>`\x1b[1m${s}\x1b[22m`,safe=s=>cleanTerminal(redact(s));
function box(lines,width,paint){
 const w=Math.max(8,Math.min(84,width-2)),inside=w-4;
 return[paint(' ╭'+'─'.repeat(w-2)+'╮'),...lines.map(line=>' '+paint('│')+' '+truncateToWidth(line,inside)+' '.repeat(Math.max(0,inside-visibleWidth(truncateToWidth(line,inside))))+' '+paint('│')),paint(' ╰'+'─'.repeat(w-2)+'╯')];
}
const descriptions={off:'Direct responses without additional reasoning.',minimal:'A small reasoning budget for straightforward work.',low:'Fast responses for simple, well-scoped tasks.',medium:'Balanced reasoning for everyday engineering.',high:'More reasoning for verification and difficult edge cases.',xhigh:'Deeper reasoning for demanding, multi-step problems.',max:'The deepest model-supported reasoning level.'};
export class EffortPanel {
 focused=true;
 constructor(ui,{levels,effort,overkill,resolve,cancel}){this.ui=ui;this.levels=levels;this.index=Math.max(0,levels.indexOf(effort));this.overkill=overkill;this.resolve=resolve;this.cancel=cancel;this.publish();}
 publish(){this.ui.effortPreview={effort:this.levels[this.index],overkill:this.overkill};this.ui.syncMotion();this.ui.render();}
 invalidate(){}
 render(width){
  const paint=this.ui.paint,level=this.levels[this.index],w=Math.min(78,width-8),labels=this.levels.map((v,i)=>i===this.index?paint(bold(v)):dim(v));
  let scale;
  if(this.levels.join('    ').length<=w){
   const cell=Math.max(5,Math.floor(w/this.levels.length));const positions=this.levels.map((_,i)=>Math.floor(cell/2)+i*cell);
   const track=Array.from({length:Math.min(w,cell*this.levels.length)},(_,x)=>{const i=positions.indexOf(x);return i>=0?(i===this.index?paint('●'):dim('○')):x<=positions[this.index]?paint('━'):dim('─');}).join('');
   scale=[labels.map((label,i)=>' '.repeat(Math.max(0,Math.floor((cell-visibleWidth(this.levels[i]))/2)))+label+' '.repeat(Math.max(0,cell-visibleWidth(this.levels[i])-Math.floor((cell-visibleWidth(this.levels[i]))/2)))).join(''),track];
  }else scale=this.levels.map((v,i)=>(i===this.index?paint('● ')+bold(v):dim('○ '+v)));
  if(this.ui.terminal.rows<28){
   const track=this.levels.map((_,i)=>i===this.index?paint('●'):dim('○')).join('━');
   return box([bold('Effort'),'',paint(bold('← '+level+' →')),track,'',`${bold('OVERKILL')}  ${this.overkill?paint('● on'):dim('○ off')}`,dim(width<48?'tab toggles workers':'tab toggles OVERKILL'),'',dim('← → adjust'),dim('↵ apply · esc cancel')],width,paint);
  }
  const lines=[bold('Effort'),'Choose how much reasoning Psi uses.','',...scale,'',paint(bold(level.toUpperCase())),descriptions[level]||'Use this model-supported reasoning level.','',`${bold('OVERKILL')}  ${this.overkill?paint('● on'):dim('○ off')}`,dim('Configured workers, each with its own model and role.'),'',dim('← → adjust · tab OVERKILL · enter apply · esc cancel')];
  return box(lines,width,paint);
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
export class StatsPanel {
 focused=true;
 constructor(ui,{data=null,resolve,cancel,refresh}){this.ui=ui;this.data=data;this.index=2;this.resolve=resolve;this.cancel=cancel;this.refresh=refresh;this.loading=false;if(!data)this.load();}
 async load(){if(this.loading)return;this.loading=true;this.error=null;try{this.data=await this.refresh();}catch(e){this.error=e.message;}finally{this.loading=false;this.ui.render();}}
 invalidate(){}
 render(width){
  const paint=this.ui.paint;if(!this.data)return box([bold('Your Psi activity'),'',this.error?safe(this.error):'Reading saved activity…','',dim('esc close')],width,paint);
  const s=this.data[this.index],wide=width>=64,tall=this.ui.terminal.rows>=30;
  const tabs=(width>=80?['This week','This month','All time']:['Week','Month','All']).map((v,i)=>i===this.index?paint(bold(`[ ${v} ]`)):dim(`  ${v}  `)).join(wide?'  ':'');
  const metric=(name,value)=>`${name.padEnd(wide?22:17)}${bold(value)}`;
  const lines=[bold('Your Psi activity'),tabs,'',metric('Tokens',compactCount(s.tokens)),metric('Active time',formatDuration(s.activeMs)),metric('Requests',s.requests.toLocaleString()),metric(wide?'Sessions / workers':'Sessions/workers',`${s.sessions} / ${s.workers}`),metric('Tool calls',s.tools.toLocaleString()),metric(wide?'Objectives completed':'Objectives',s.goals.toLocaleString()),''];
  if(wide)lines.push(`${dim('Input')} ${compactCount(s.input)}   ${dim('Output')} ${compactCount(s.output)}   ${dim('Cache read')} ${compactCount(s.cacheRead)} (${s.cachePercent}%)`,'');
  const providers=Object.entries(s.providers).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,tall?3:1);
  if(providers.length&&this.ui.terminal.rows>=26){lines.push(bold('Providers'));for(const [name,p]of providers){const cells=Math.max(1,Math.round(p.tokens/Math.max(1,s.tokens)*(wide?18:8)));lines.push(`${safe(name).slice(0,20).padEnd(wide?22:14)}${paint('█'.repeat(cells))} ${compactCount(p.tokens)}`);}lines.push('');}
  const days=[];for(let i=27;i>=0;i--){const d=new Date(s.now);d.setDate(d.getDate()-i);days.push(s.days[dayKey(d)]||0);}const max=Math.max(1,...days);
  if(this.ui.terminal.rows>=26)lines.push(dim('Daily token activity · last 28 days'),days.map(n=>n?paint(['▂','▄','▆','█'][Math.min(3,Math.floor(n/max*3))]):dim('·')).join(' '));
  if(this.error)lines.push(dim('Refresh failed: '+safe(this.error)));
  lines.push('',dim(wide?'Saved Psi activity only. Weeks start Monday in local time.':'Psi history only.'));
  if(s.unknownDatedRequests||s.malformed)lines.push(dim('Some historical records lack dates or could not be read.'));
  if(wide)lines.push(dim('Active time includes model/tools, excludes quota and idle waits.'),dim('Overlapping workers count once; agent time '+formatDuration(s.agentMs)+'.'));
  lines.push('',dim(this.loading?'Refreshing…':wide?'← → period · r refresh · esc close':'← → tabs · esc close'));
  if(!wide)lines.splice(-1,0,dim('r refresh'));
  const available=Math.max(5,this.ui.terminal.rows-2),body=lines.length>available?[...lines.slice(0,available-1),lines.at(-1)]:lines;
  const rendered=box(body,width,paint);return [...rendered,...Array.from({length:Math.max(0,this.ui.terminal.rows-rendered.length)},()=> ' '.repeat(width))];
 }
 handleInput(data){
  if(matchesKey(data,'escape')||matchesKey(data,'enter')){this.cancel();return;}
  if(matchesKey(data,'left'))this.index=(this.index+2)%3;else if(matchesKey(data,'right')||matchesKey(data,'tab'))this.index=(this.index+1)%3;
  else if(data==='r'&&!this.loading)void this.load();
  this.ui.render();
 }
}
