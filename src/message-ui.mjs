import { Editor, Markdown, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
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

// Keep the native editor's wrapping, cursor, history and completion behavior.
// The mode control occupies its own fixed gutter inside the input row.
export class Composer extends Editor {
  constructor(ui, theme) {
    super(ui.tui, theme, { paddingX: 1, autocompleteMaxVisible: 7 });
    this.ui = ui;
  }
  render(width) {
    const mode = this.ui.app.engine.pendingSettings.agentMode || this.ui.app.engine.config.agentMode || 'execute';
    const label = width >= 38 ? mode.toUpperCase() : mode === 'plan' ? 'PLAN' : 'EXEC';
    this.modeWidth = Math.min(width > 19 ? visibleWidth(label)+6 : 0, Math.max(0,width-8));
    const innerWidth = Math.max(1,width-this.modeWidth);
    const lines = super.render(innerWidth);
    const pending = !!this.ui.app.engine.pendingSettings.agentMode || !!this.ui.modeSwitch;
    return lines.map((line,i) => {
      if (!this.modeWidth) return line;
      if (i === 0 || i === this.renderedVisibleLineCount+1) return dim('─'.repeat(this.modeWidth))+line;
      const prefix = i === 1 ? `  ${this.ui.paint(bold(label))}${dim(pending?' ◌ ':' ▾ ')} ` : ' '.repeat(this.modeWidth);
      return prefix+line;
    });
  }
  handleMouse(event) {
    if (this.modeWidth && event.type === 'click' && event.button === 'left' && event.y === 1 && event.x < this.modeWidth) {
      this.ui.toggleMode();
      return { handled: true, render: true };
    }
    return super.handleMouse({ ...event, x: Math.max(0,event.x-(this.modeWidth||0)), width: Math.max(1,event.width-(this.modeWidth||0)) });
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
