import { importantTool } from './activity-kind.mjs';
export { importantTool } from './activity-kind.mjs';
import { Editor, Markdown, Text, truncateToWidth, visibleWidth, sliceByColumn, stripTerminalSequences } from '@earendil-works/pi-tui';
import { accentColor,accentFlow } from './theme.mjs';
import { cleanTerminal, redact } from './storage.mjs';

const dim = s => `\x1b[2m${s}\x1b[22m`;
const bold = s => `\x1b[1m${s}\x1b[22m`;
const safe = s => cleanTerminal(redact(s));
const colors=new Map();
const pulse = (text, ui, strength) => {
  const config=ui.app.engine.config,key=config.accent||'sage';
  if(!colors.has(key)){if(colors.size>=16)colors.clear();colors.set(key,accentColor(config));}
  const { r, g, b } = colors.get(key);
  return `\x1b[38;2;${[r,g,b].map(n=>Math.round(n*strength)).join(';')}m${text}\x1b[39m`;
};

// The mode chip lives on the border: draft text and slash completion retain full width.
export function flowAccent(text,ui,offset=0){
  if(ui.app.engine.config.animations===false)return ui.paint(text);
  const config=ui.app.engine.config,key=config.accent||'sage';
  if(!colors.has(key)){if(colors.size>=16)colors.clear();colors.set(key,accentColor(config));}
  return accentFlow(text,config,{time:ui.now(),offset,color:colors.get(key)});
}
export class Composer extends Editor {
  constructor(ui,theme){super(ui.tui,theme,{paddingX:1,autocompleteMaxVisible:7});this.ui=ui;}
  handleInput(data){
    if(this.ui.composerSearch&&this.ui.composerSearch.handleInput(data))return;
    super.handleInput(data);
  }
  render(width){
    const lines=super.render(width),mode=this.ui.app.engine.pendingSettings.agentMode||this.ui.app.engine.config.agentMode||'execute';
    const pending=!!this.ui.app.engine.pendingSettings.agentMode||!!this.ui.modeSwitch;
    const label=` ${width>=28?mode.toUpperCase():mode==='plan'?'PLAN':'EXEC'} ${pending?'◌':'▾'} `;
    const x=Math.max(1,width-visibleWidth(label)-2),w=Math.min(visibleWidth(label),Math.max(0,width-x));this.modeBounds={x,y:0,width:w};
    const radiant=this.ui.isOverkill();
    const edge=(line,offset)=>radiant?flowAccent(stripTerminalSequences(line).replaceAll('─','━'),this.ui,offset):line;
    lines[0]=edge(sliceByColumn(lines[0],0,x),0)+this.ui.paint(bold(truncateToWidth(label,w)))+edge(sliceByColumn(lines[0],x+w),x+w);
    const bottom=this.renderedVisibleLineCount+1;lines[bottom]=edge(lines[bottom],13);
    return lines;
  }
  handleMouse(event){
    const b=this.modeBounds;
    if(b&&event.type==='click'&&event.button==='left'&&event.y===b.y&&event.x>=b.x&&event.x<b.x+b.width){this.ui.toggleMode();return{handled:true,render:true};}
    return super.handleMouse(event);
  }
}

export class UserMessage {
  constructor(ui,text,{animate=true}={}){
    this.ui=ui;this.started=ui.now();this.animate=animate;this.text=safe(text);this.expanded=false;
    this.body=new Text(this.text,0,0);this.preview=new Text(this.text.slice(0,1800),0,0);
  }
  invalidate(){this.body.invalidate();this.preview.invalidate();}
  toggle(){if(!this.collapsible)return false;this.ui.scroll.scrollTo(this.ui.scroll.scrollTop,{disableFollow:true});this.expanded=!this.expanded;this.ui.tui.invalidate();this.ui.render();return true;}
  handleMouse(event){if(event.type==='click'&&event.button==='left'&&event.y===this.toggleRow&&this.toggle())return{handled:true,render:true};}
  render(width){
    const enabled=this.animate&&this.ui.app.engine.config.animations!==false,t=enabled?Math.min(1,Math.max(0,(this.ui.now()-this.started)/240)):1;
    const marker=pulse('›',this.ui,0.48+0.52*(1-(1-t)**4)),room=Math.max(1,width-2);
    const preview=this.preview.render(room);this.collapsible=this.text.length>1800||preview.length>6;
    const all=this.collapsible?(this.expanded?this.body.render(room):preview.slice(0,3)):preview;
    const lines=all.map((line,i)=>truncateToWidth((i===0?marker+' ':'  ')+line,width));
    this.toggleRow=null;
    if(this.collapsible){this.toggleRow=Math.min(3,lines.length);lines.splice(this.toggleRow,0,truncateToWidth('  '+this.ui.paint(this.expanded?'▾ Hide prompt':'▸ Full prompt')+dim(' · ctrl+p'),width));}
    return [...lines,''];
  }
}
export const toolDetails=ui=>ui.expandedTools??(ui.app.engine.config.toolActivity==='full');
export class AssistantMessage {
  constructor(ui,text='',phase=''){this.ui=ui;this.phase=phase;this.active=!!phase;this.text=text;this.started=ui.now();this.body=new Markdown(safe(text),0,0,ui.markdownTheme);}
  setText(text){this.text=text;this.body.setText(safe(text));}
  invalidate(){this.body.invalidate();}
  render(width){
    if(!this.text)return[];
    const animated=this.active&&this.ui.app.engine.config.animations!==false,strength=animated?0.78+0.22*(0.5-0.5*Math.cos((this.ui.now()-this.started)/1400*Math.PI*2)):1;
    const lines=this.body.render(Math.max(1,width-2));
    const tail=['stopped','partial response'].includes(this.phase)?[dim('  '+this.phase)]:[];
    return [...lines.map((line,i)=>truncateToWidth((i===0?pulse('•',this.ui,strength)+' ':'  ')+line,width)),...tail,''];
  }
}
export function exploration(call){return ['read','search','fetch','search_web','battlecode_inspect'].includes(call.name)||call.name==='browser'&&['open','read','close'].includes(call.arguments?.action);}
const oneLine=value=>safe(String(value||'')).replace(/\s+/g,' ').trim();
function description(call){
  const a=call.arguments||{};
  if(call.name==='read')return ['Read',a.path];
  if(call.name==='search')return a.pattern!==undefined?['Search',a.pattern+(a.path?' in '+a.path:'')]:['List',a.path||'.'];
  if(call.name==='fetch')return ['Fetch',a.url];
  if(call.name==='search_web')return ['Search web',a.query];
  if(call.name==='browser')return ['Browser',a.url||a.action];
  return [call.name.replaceAll('_',' '),a.path||a.url||a.query||a.action||''];
}
export class ToolMessage {
  constructor(ui,event){this.ui=ui;this.call=event.call;this.started=ui.now();this.active=true;this.output='';}
  finish(event){
    this.active=false;this.failed=event.result.isError;this.duration=event.duration;
    const raw=event.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');let text=raw;
    try{const p=JSON.parse(raw);if(typeof p==='string')text=p;
      else if(p&&typeof p==='object'&&'output'in p){this.outcome=p.status;this.exitCode=p.exitCode;this.jobId=p.id;text=p.output||'';}
      else if(p?.title&&p?.url)text=p.title+'\n'+p.url;
      else if(p&&typeof p==='object'&&p.id&&p.status){this.outcome=p.status;this.jobId=p.id;}
    }catch{}
    this.output=safe(text);if(this.output.length>24000)this.output=this.output.slice(0,24000)+'\n[More in the session journal]';
    this.preview=this.output.split('\n').slice(0,3).join('\n').slice(0,300);
  }
  interrupt(){if(this.active){this.active=false;this.interrupted=true;this.output='Interrupted before a result was recorded.';}}
  invalidate(){}
  marker(){
    if(this.failed)return '\x1b[31m•\x1b[39m';
    if(this.active){const strength=this.ui.app.engine.config.animations===false?1:0.75+0.25*(0.5-0.5*Math.cos((this.ui.now()-this.started)/1300*Math.PI*2));return pulse('•',this.ui,strength);}
    return this.interrupted?dim('•'):this.ui.paint('•');
  }
  action(){
    const n=this.call.name,a=this.call.arguments||{};
    if(n==='bash')return [this.active?'Running':'Ran',a.command];
    if(n==='write')return [this.active?'Writing':'Wrote',a.path];
    if(n==='edit')return [this.active?'Editing':'Edited',a.path];
    if(n==='job')return [this.active?'Waiting for job':'Checked job',a.id||a.action];
    if(n==='benchmark')return [this.active?'Benchmarking':'Benchmarked',a.manifest];
    if(n==='progress')return [this.active?'Updating plan':'Updated plan',''];
    if(n==='checkpoint')return [this.active?'Saving checkpoint':'Saved checkpoint',''];
    if(n==='finish')return [this.failed?'Completion rejected':'Completed objective',''];
    if(n==='agent')return [this.active?'Subagent':'Subagent',a.name||a.action];
    return description(this.call);
  }
  outputLines(width,{nested=false}={}){
    const lines=[],prefix=nested?'    ':'  ',expanded=toolDetails(this.ui);
    if(this.jobId&&(expanded||this.failed||this.interrupted||['running','queued'].includes(this.outcome)))lines.push(truncateToWidth(prefix+dim(`└ job ${this.jobId} · ${this.outcome||'unknown'}${this.historical&&['running','queued'].includes(this.outcome)?' at save':''}${this.exitCode!==undefined?' · exit '+this.exitCode:''}`),width));
    const show=expanded||this.failed||this.interrupted;
    if(show&&this.output){
      const all=this.output.split('\n'),limit=expanded?20:this.failed?5:3;
      const output=all.length>limit?[...all.slice(0,Math.max(1,limit-1)),dim(`… +${all.length-limit+1} lines · ctrl+t`)]:all;
      for(const [i,line]of output.entries())lines.push(truncateToWidth(prefix+dim(i===0&&!this.jobId?'└ ':'  ')+dim(line),width));
    }else if(expanded&&!this.active&&!this.failed&&this.call.name==='edit'){
      const a=this.call.arguments||{},removed=String(a.old||'').split('\n'),added=String(a.new||'').split('\n');
      for(const [sign,items]of [['-',removed],['+',added]])for(const line of items.slice(0,2))lines.push(truncateToWidth(prefix+dim('  ')+(sign==='+'?this.ui.paint('+ '+safe(line)):'\x1b[31m- '+safe(line)+'\x1b[39m'),width));
      if(removed.length+added.length>4)lines.push(truncateToWidth(prefix+dim('  … · ctrl+t'),width));
    }
    if(expanded&&!lines.length&&!this.active&&!this.failed&&this.call.name==='bash')lines.push(truncateToWidth(prefix+dim('└ (no output)'),width));
    return lines;
  }
  render(width){
    if(!toolDetails(this.ui)&&!importantTool(this))return[];
    const [action,detail]=this.action(),suffix=this.failed?' · failed':this.interrupted?' · stopped':this.active?'':Number.isFinite(this.exitCode)&&this.exitCode!==0?' · exit '+this.exitCode:'';
    const prefix=this.marker()+' '+bold(action)+' ',room=Math.max(0,width-visibleWidth(prefix)-visibleWidth(suffix));
    const command=toolDetails(this.ui)&&detail?new Text(safe(String(detail)),0,0).render(Math.max(1,width-4)).slice(0,12).map(line=>truncateToWidth('    '+dim(line),width)):[];
    const compactDetail=!toolDetails(this.ui)&&this.call.name==='bash'&&(String(detail).length>160||String(detail).includes('\n'))?(this.call.arguments?.label||(/\bpython[0-9.]*/.test(detail)?'Python script':'Shell command')):detail;
    return [truncateToWidth(prefix+truncateToWidth(oneLine(compactDetail),room)+dim(suffix),width),...command,...this.outputLines(width),''];
  }
}
export class ExplorationGroup {
  constructor(ui,tool){this.ui=ui;this.tools=[tool];}
  add(tool){this.tools.push(tool);}
  invalidate(){}
  render(width){
    if(!toolDetails(this.ui))return this.tools.filter(t=>t.failed||t.interrupted).flatMap(t=>t.render(width));
    const active=this.tools.find(t=>t.active),failed=this.tools.some(t=>t.failed),title=active?'Exploring':'Explored';
    const mark=active?active.marker():failed?'\x1b[31m•\x1b[39m':dim('•');
    const lines=[truncateToWidth(mark+' '+bold(title)+(failed?dim(' · errors'):''),width)];
    const limit=toolDetails(this.ui)?20:5,visible=this.tools.length<=limit?this.tools:this.tools.slice(-limit);
    for(const [i,tool]of visible.entries()){
      const [name,detail]=description(tool.call),prefix=i===0?'  └ ':'    ',status=tool.failed?' · failed':tool.interrupted?' · stopped':'';
      lines.push(truncateToWidth(dim(prefix)+this.ui.paint(name)+' '+oneLine(detail)+dim(status),width));
      lines.push(...tool.outputLines(width,{nested:true}));
    }
    if(this.tools.length>visible.length)lines.push(truncateToWidth(dim(`    … ${this.tools.length-visible.length} earlier calls · ctrl+t`),width));
    return [...lines,''];
  }
}

export class FileChanges {
  constructor(ui,tool){this.ui=ui;this.tools=[tool];}
  add(tool){this.tools.push(tool);}
  invalidate(){}
  render(width){
    if(toolDetails(this.ui))return this.tools.flatMap(t=>t.render(width));
    const valid=this.tools.filter(t=>!t.failed&&!t.interrupted),paths=[...new Set(valid.map(t=>oneLine(t.call.arguments?.path||'(unknown file)')))],active=valid.some(t=>t.active);
    const label=paths.length===1?paths[0]:`${paths.length} files`;
    const lines=paths.length?[truncateToWidth(this.ui.paint('•')+' '+bold(active?'Updating':'Updated')+' '+label,width)]:[];
    if(paths.length>1)lines.push(truncateToWidth(dim('  '+paths.slice(0,3).join(' · ')+(paths.length>3?` · +${paths.length-3}`:'')),width));
    return[...lines,...this.tools.filter(t=>t.failed||t.interrupted).flatMap(t=>t.render(width)),...(lines.length?['']:[])];
  }
}
export class SubagentNotice {
  constructor(ui,event){this.ui=ui;this.event=event;}
  invalidate(){}
  render(width){
    const a=this.event.agent,launched=this.event.type==='agent_started',failed=!launched&&!['completed','idle'].includes(a.status);
    const title=launched?'Launched subagent':failed?'Subagent '+(a.status||'stopped'):'Subagent report';
    const head=truncateToWidth(this.ui.paint('•')+' '+bold(title)+' '+oneLine(a.name)+(launched&&a.group?dim(' · '+oneLine(a.group)):''),width);
    const summary=!launched&&(a.result?.summary||a.result?.error);
    const body=summary?new Text(safe(summary),0,0).render(Math.max(1,width-2)).slice(0,3).map(l=>'  '+l):[];
    return[head,...body,''];
  }
}
