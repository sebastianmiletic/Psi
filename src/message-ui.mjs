import { Editor, Markdown, Text, truncateToWidth, visibleWidth, sliceByColumn, stripTerminalSequences } from '@earendil-works/pi-tui';
import { accentColor } from './theme.mjs';
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
  const {r,g,b}=colors.get(key);let output='',last=-1;
  for(const [i,c]of Array.from(text).entries()){
    const bucket=Math.round((0.5+0.5*Math.sin((i+offset)/11-ui.now()/850))*15);
    if(bucket!==last){const strength=0.75+Math.pow(bucket/15,2)*0.45;output+=`\x1b[38;2;${[r,g,b].map(n=>Math.min(255,Math.round(n*strength))).join(';')}m`;last=bucket;}
    output+=c;
  }
  return output+'\x1b[39m';
}
export class Composer extends Editor {
  constructor(ui,theme){super(ui.tui,theme,{paddingX:1,autocompleteMaxVisible:7});this.ui=ui;}
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
  constructor(ui, text, { animate=true }={}) {
    this.ui=ui; this.started=ui.now(); this.animate=animate;
    this.body=new Text(safe(text),0,0);
  }
  invalidate() { this.body.invalidate(); }
  render(width) {
    const enabled=this.animate && this.ui.app.engine.config.animations!==false;
    const t=enabled?Math.min(1,Math.max(0,(this.ui.now()-this.started)/240)):1;
    const strength=0.48+0.52*(1-(1-t)**4);
    const marker=pulse('›',this.ui,strength);
    return [...this.body.render(Math.max(1,width-5)).map((line,i)=>truncateToWidth(i===0?`  ${marker}  ${line}`:`     ${line}`,width)), ''];
  }
}

export class AssistantMessage {
  constructor(ui,text='',phase='') {
    this.ui=ui;this.phase=phase;this.active=!!phase;this.text=text;this.started=ui.now();
    this.body=new Markdown(safe(text),5,0,ui.markdownTheme);
  }
  setText(text) { this.text=text;this.body.setText(safe(text)); }
  invalidate() { this.body.invalidate(); }
  render(width) {
    const animated=this.active && this.ui.app.engine.config.animations!==false;
    const elapsed=Math.max(0,this.ui.now()-this.started);
    const strength=animated?0.72+0.28*(0.5-0.5*Math.cos(elapsed/1400*Math.PI*2)):1;
    const dots=animated?'.'.repeat(1+Math.floor(elapsed/320)%3).padEnd(3):'';
    const status=this.phase?dim(`  ${this.phase}${dots}`):'';
    const header=truncateToWidth(`  ${pulse('Ψ',this.ui,strength)}  ${bold('Psi')}${status}`,width);
    return this.text ? [header,...this.body.render(width),''] : [header];
  }
}

export class ToolMessage {
  constructor(ui,event) { this.ui=ui;this.call=event.call;this.started=ui.now();this.active=true; }
  finish(event) {
    this.active=false;this.failed=event.result.isError;this.duration=event.duration;
    const raw=event.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    let text=raw;
    try {
      const p=JSON.parse(raw);
      if(p&&typeof p==='object'&&'output'in p){
        this.outcome=p.status;
        text=p.id?`job ${p.id} · ${p.status}${p.exitCode!==undefined?` · exit ${p.exitCode}`:''}\n${p.output||''}`:p.output;
      }else if(p?.title&&p?.url)text=`${p.title}\n${p.url}`;
    } catch {}
    this.preview=safe(text).split('\n').slice(0,3).join('\n').slice(0,300);
  }
  invalidate() {}
  render(width) {
    const a=this.call.arguments,detail=safe(String(a.command||a.path||a.url||a.query||a.action||''));
    const state=safe(this.active?'running':this.outcome||(this.failed?'failed':'done'));
    const icon=this.active?'↳':this.failed?'!':['running','queued'].includes(this.outcome)?'↗':'✓';
    const strength=this.active&&this.ui.app.engine.config.animations!==false?0.7+0.3*(0.5-0.5*Math.cos((this.ui.now()-this.started)/1300*Math.PI*2)):1;
    const mark=this.failed?`\x1b[31m${icon}\x1b[39m`:pulse(icon,this.ui,strength);
    const suffix=dim(` · ${state}${this.active?'':` · ${(this.duration/1000).toFixed(1)}s`}`);
    const prefix=`     ${mark} ${safe(this.call.name)}`;
    const room=Math.max(0,width-visibleWidth(prefix)-visibleWidth(suffix)-2);
    const header=truncateToWidth(`${prefix}${detail&&room>1?'  '+truncateToWidth(detail,room):''}${suffix}`,width);
    const body=this.preview?this.preview.split('\n').map(line=>truncateToWidth('       '+dim(line),width)):[];
    return [header,...body,''];
  }
}
