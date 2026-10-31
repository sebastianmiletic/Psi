import {
  ProcessTerminal, TuiAltScreen, VStack, ScrollView, Container, Text, Markdown, Input, SelectList,
  CombinedAutocompleteProvider, matchesKey, truncateToWidth, CURSOR_MARKER,
  colorToRgb, parseColor, visibleWidth,
} from '@earendil-works/pi-tui';
import { accentText } from './theme.mjs';
import { usageLabel,applicableQuota } from './usage.mjs';
import { EffortPanel,StatsPanel } from './panels.mjs';
import { PsiHeader, PsiAnimation } from './logo.mjs';
import { Composer,UserMessage,AssistantMessage,ToolMessage } from './message-ui.mjs';
import { cleanTerminal, redact } from './storage.mjs';

const rgb = colorToRgb(parseColor('oklch(68% 0.105 162)'));
const accent = t => `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${t}\x1b[39m`;
const dim = t => `\x1b[2m${t}\x1b[22m`;
const bold = t => `\x1b[1m${t}\x1b[22m`;
const error = t => `\x1b[31m${t}\x1b[39m`;
const safe = t => cleanTerminal(redact(t));
const selectionTheme = { selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim };
const markdownTheme = {
  heading: bold, link: accent, linkUrl: dim, code: accent, codeBlock: t => t,
  codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: accent,
  bold, italic: t => `\x1b[3m${t}\x1b[23m`, strikethrough: t => `\x1b[9m${t}\x1b[29m`, underline: t => `\x1b[4m${t}\x1b[24m`,
};
export const commands = [
 ['directory','Manage allowed working directories'],['settings','Appearance, accounts, workers and execution'],['agents','Configure and inspect OVERKILL workers'],['update','Install the latest GitHub release'],
 ['project','Inspect the Battlecode baseline and controller'],['experiments','Inspect durable experiments'],['logo','Open the Psi logo'],['model','Choose a model'],['effort','Thinking effort; Tab toggles OVERKILL'],['accounts','Login, switch or remove accounts'],
 ['provider','Add a custom endpoint'],['loop','Set a persistent objective'],['new','Start a fresh session'],['resume','Resume a saved session'],['cd','Start in another workspace'],['usage','Reported account usage'],['tools','Available AI tools'],['cost','Session token and cost totals'],
 ['stats','Weekly, monthly and all-time activity'],['summary-model','Choose the compaction model'],['compact','Summarize earlier context'],['checkpoint','Read or write the progress note'],['profile','Battlecode or general guidance'],['refresh','Refresh model catalog'],['status','Workspace and run state'],['export','Export session Markdown'],['help','Commands and keyboard shortcuts'],['quit','Exit Psi']
].map(([name,description])=>({name,description}));

class Transcript extends Container {
  addChild(child) { super.addChild(child); if (this.children.length > 100) this.children.splice(0, this.children.length - 100); }
}
class SecretInput {
  value = ''; focused = true;
  constructor(onSubmit, onCancel) { this.onSubmit = onSubmit; this.onCancel = onCancel; }
  invalidate() {}
  handleInput(data) {
    if (matchesKey(data, 'enter')) { this.onSubmit(this.value); return; }
    if (matchesKey(data, 'escape')) { this.onCancel(); return; }
    if (matchesKey(data, 'backspace')) this.value = this.value.slice(0, -1);
    else if (matchesKey(data, 'ctrl+u')) this.value = '';
    else this.value += cleanTerminal(data.replace(/\x1b\[20[01]~/g, '')).replace(/[\r\n]/g, '');
  }
  render(width) { return [truncateToWidth('  ' + '•'.repeat(this.value.length), Math.max(1, width - 1)) + (this.focused ? CURSOR_MARKER : '')]; }
}
export class TerminalUI {
  constructor(app, { terminal = new ProcessTerminal(), now=()=>performance.now() } = {}) {
    this.app = app; this.terminal = terminal; this.tui = new TuiAltScreen(terminal);
    this.now=now;this.openTools=new Map();
    this.paint=t=>accentText(t,app.engine.config);
    this.selectionTheme={...selectionTheme,selectedPrefix:this.paint,selectedText:t=>this.paint(bold(t))};
    this.markdownTheme={...markdownTheme,link:this.paint,code:this.paint,listBullet:this.paint};
    this.transcript = new Transcript(); this.panel = new Container(); this.pending = null;
    this.editor = new Composer(this, { borderColor: dim, selectList: this.selectionTheme });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, app.session.meta.cwd));
    this.editor.onSubmit = text => {
      if (!text.trim()) return;
      this.editor.addToHistory(text); this.editor.setText('');
      void app.submit(text).catch(e => this.note(e.message, true));
    };
    this.header = new PsiHeader({ app, onActivate: () => this.showLogo(), format: t => bold(safe(t)), subdued: t => dim(safe(t)) });
    this.footer = { invalidate() {}, render: width => {
      const c = app.engine.config;
      const slash = c.model.indexOf('/');
      const model = safe(slash >= 0 ? c.model.slice(slash + 1) : c.model);
      const state={...c,...app.engine.pendingSettings,...this.effortPreview};
      const right = truncateToWidth(`${safe(state.effort)}${state.overkill?' · OVERKILL':''}`, Math.max(0,width-3));
      const left = truncateToWidth(`  ${model}`, Math.max(0,width-visibleWidth(right)-3));
      const gap = Math.max(1,width-visibleWidth(left)-visibleWidth(right)-1);
      return [left+' '.repeat(gap)+(state.overkill?this.paint(right):dim(right)), ...(app.engine.config.showUsage===false?[]:[truncateToWidth('  '+dim(safe(usageLabel(app.activeAccount,app.activeUsage,{sessionCost:app.session.meteredCost,costKnown:app.session.meteredCostKnown,omitQuota:applicableQuota(app.activeUsage)?.label}))),width)])];
    } };
    this.progressBar={invalidate(){},render:width=>{
      const quota=applicableQuota(app.activeUsage),state=app.session.state.progress,pct=Math.round(Math.max(0,Math.min(100,quota?.usedPercent??state?.percent??0)));
      const label=quota?(width>=70?`${quota.label} limit · ${pct}% used · ${100-pct}% left`:`${quota.label} · ${pct}% used`):(width>=70?`Goal · ${pct}% · ${100-pct}% remaining · est.`:`Goal ${pct}% · est.`);
      const available=Math.max(0,width-visibleWidth(label)-6),size=Math.min(30,available),filled=Math.round(size*pct/100);
      return[truncateToWidth('  '+accentText('█'.repeat(filled),{accent:'blue'})+dim('░'.repeat(size-filled))+'  '+dim(safe(label)),width)];
    }};
    this.scroll = new ScrollView(this.transcript, { follow: 'end', primary: true, scrollbar: 'auto' });
    this.panelScroll = new ScrollView(this.panel, { follow: 'end', scrollbar: 'auto' });
    this.layout = new VStack([
      { component: this.header, basis: 'auto', shrink: 1, minSize: 0, visible: viewport => viewport.height >= 14 && app.engine.config.showLogo!==false && !this.pending },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: this.panelScroll, basis: 'auto', shrink: 1, minSize: 0 },
      { component: this.editor, basis: 'auto', shrink: 1, minSize: 3 },
      { component: this.footer, basis: 'auto', shrink: 0, minSize: 1 },
      { component: this.progressBar, basis: 1, shrink: 0, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(this.layout);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (this.logoAnimation && (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d'))) { this.hideLogo(); return { consume: true }; }
      if(matchesKey(data,'escape')&&this.pending){this.lastEscape=0;this.pending.cancel();return{consume:true};}
      if (matchesKey(data, 'ctrl+c')) {
        if (app.authController) { app.authController.abort(); this.pending?.cancel(); }
        else if (this.pending) this.pending.cancel();
        else if (app.engine.busy) app.engine.stop();
        else void app.close();
        return { consume: true };
      }
      if(matchesKey(data,'shift+tab')&&!this.pending){this.toggleMode();return{consume:true};}
      if(matchesKey(data,'escape')&&!this.pending&&app.engine.busy){const now=Date.now();if(now-(this.lastEscape||0)<600){this.lastEscape=0;app.engine.stop();}else this.lastEscape=now;return{consume:true};}
      if (matchesKey(data, 'ctrl+d') && !this.pending && !this.editor.getText()) { void app.close(); return { consume: true }; }
    });
  }
  start() {
    this.closed=false;
    this.tui.start();this.syncMotion();
  }
  stop() { this.closed=true; this.hideLogo();this.stopMotion();clearTimeout(this.renderTimer); this.pending?.cancel(); clearTimeout(this.renderTimer); this.tui.stop(); }
  toggleMode() {
    if(this.modeSwitch)return;
    const mode=this.app.engine.pendingSettings.agentMode||this.app.engine.config.agentMode;
    this.modeSwitch=this.app.setMode(mode==='plan'?'execute':'plan').catch(e=>this.note(e.message,true)).finally(()=>{this.modeSwitch=null;this.render();});
    this.render();
  }
  stopMotion() { clearInterval(this.motionTimer);this.motionTimer=null; }
  isOverkill(){return this.effortPreview?.overkill??this.app.engine.pendingSettings.overkill??this.app.engine.config.overkill;}
  syncMotion() {
    const active=this.isOverkill()||this.response?.active||this.openTools.size||this.lastUser?.animate!==false&&this.lastUser&&this.now()-this.lastUser.started<240;
    if(this.closed||this.app.engine.config.animations===false||!active){this.stopMotion();return;}
    if(!this.motionTimer){this.motionTimer=setInterval(()=>{this.syncMotion();if(!this.closed)this.tui.requestRender();},80);this.motionTimer.unref();}
  }
  finishResponse(phase='') {
    if(this.response){this.response.phase=phase;this.response.active=false;if(!this.response.text)this.transcript.removeChild(this.response);}
    this.response=null;this.stream=null;this.syncMotion();
  }
  showLogo() {
    if (this.logoAnimation || this.pending) return;
    this.logoAnimation = new PsiAnimation({ terminal: this.terminal, config:()=>this.app.engine.config, onClose: () => this.hideLogo() });
    this.logoOverlay = this.tui.showOverlay(this.logoAnimation, { width: '100%', maxHeight: '100%', row: 0, col: 0, margin: 0 });
    if(this.app.engine.config.animations!==false){this.logoTimer = setInterval(() => this.tui.requestRender(), 1000 / 24); this.logoTimer.unref();}
    this.tui.requestRender();
  }
  hideLogo() {
    clearInterval(this.logoTimer); this.logoTimer = null; this.logoAnimation = null;
    this.logoOverlay?.hide(); this.logoOverlay = null;
  }
  render() {
    if(this.closed)return;
    if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.tui.requestRender(); }, 35);
  }
  note(text, isError = false) { this.transcript.addChild(new Text(`  ${isError ? error(safe(text)) : dim(safe(text))}`, 0, 1)); this.render(); }
  user(text,options) { this.lastUser=new UserMessage(this,text,options);this.transcript.addChild(this.lastUser);if(options?.animate!==false)this.syncMotion();this.render(); }
  markdown(text, label = true) {
    const component = label?new AssistantMessage(this,text):new Markdown(safe(text),5,1,this.markdownTheme);this.transcript.addChild(component);this.render();return component;
  }
  event(event) {
    if(this.closed)return;
    if(event.type==='settings_queued'&&!Object.keys(event.patch||event.settings||{}).every(k=>['agentMode','effort','overkill'].includes(k)))this.note('Settings saved for the next model/tool boundary.');
    if(event.type==='settings_queued')this.syncMotion();
    if(event.type==='settings'){this.syncMotion();this.tui.invalidate();this.tui.requestRender(true);}
    if(event.type==='waiting'){this.finishResponse('partial response');this.note(event.reason+' · Escape twice to stop; /settings or /accounts can resolve the wait.');}
    if(event.type==='account_switched')this.note(`Switched account: ${event.previous} → ${event.account.name}`);
    if(event.type==='model_fallback')this.note(`Using configured fallback: ${event.model}`);
    if(event.type==='account_exhausted')this.note(`${event.account.name}: checking another configured account.`);
    if (event.type === 'request_start') {
      this.finishResponse('partial response');this.activity=event.summary?'compacting':'thinking';this.streamText='';
      this.response=new AssistantMessage(this,'',event.summary?'compacting context':'thinking');this.stream=this.response;
      this.transcript.addChild(this.response);this.syncMotion();
    }
    if (event.type === 'text_delta' && !event.summary) {
      if(!this.response){this.response=new AssistantMessage(this,'','responding');this.stream=this.response;this.transcript.addChild(this.response);this.streamText='';}
      this.activity = 'writing';this.response.phase='responding';this.streamText += event.delta;
      // UI memory is bounded separately from the full session journal.
      this.stream.setText(safe(this.streamText.slice(-100000)));this.syncMotion();this.render();
    }
    if(event.type==='request_end')this.finishResponse();
    if (event.type === 'tool_start') {
      this.activity = event.call.name;
      const tool=new ToolMessage(this,event);this.openTools.set(event.call.id,tool);this.transcript.addChild(tool);this.syncMotion();
    }
    if (event.type === 'tool_end') {
      const tool=this.openTools.get(event.call.id)||new ToolMessage(this,event);
      if(!this.openTools.has(event.call.id))this.transcript.addChild(tool);
      tool.finish(event);this.openTools.delete(event.call.id);this.syncMotion();
    }
    if (event.type === 'retry') {this.finishResponse('partial response');this.note(`Provider retry ${event.attempt} in ${(event.delay / 1000).toFixed(1)}s: ${event.error}`, true);}
    if (event.type === 'compacted') this.note(`Context compacted: ~${event.before} → ~${event.after} tokens. Full history saved.`);
    if (event.type === 'queued') this.note('Message queued for the next tool boundary.');
    if (event.type === 'stopped') this.note('Stopped. Queued messages and unfinished goals are saved.');
    if(event.type==='progress'){this.note(event.update);if(this.app.engine.config.agentMode==='plan')this.markdown(event.steps.map((s,i)=>`${i+1}. ${s.title}`).join('\n'),false);}
    if(event.type==='agent_started')this.note(`Worker started: ${event.agent.name} · ${event.agent.model}`);
    if(event.type==='agent_finished')this.note(`Worker ${event.agent.name}: ${event.agent.status}`);
    if (event.type === 'error') this.note(event.error, true);
    if (event.type === 'goal_complete') this.note(`Objective complete. ${event.summary}`);
    if (event.type === 'run_end') {this.finishResponse(event.status==='stopped'?'stopped':['error','limited'].includes(event.status)?'partial response':'');this.activity='';this.openTools.clear();this.syncMotion();}
    this.render();
  }
  async choose(title, items, options={}) {
    if (!items.length) { this.note('No items available.'); return null; }
    return this.interact(title, ({ resolve, cancel }) => {
      const input = new Input({ prompt: '  Search: ', placeholder: 'type to filter' });
      input.focused = true;
      const list = new SelectList(items, 9, this.selectionTheme, { minPrimaryColumnWidth: 22, maxPrimaryColumnWidth: 55 });
      list.onSelect = item => resolve(item.value); list.onCancel = cancel;
      const component = {
        focused: true, invalidate() { input.invalidate(); list.invalidate(); },
        render: width => [...(options.status?[dim('  '+options.status()),'']:[]),...input.render(width), '', ...list.render(width), '', dim('  ↑ ↓ choose   enter select   esc back')],
        handleInput: data => {
          if(matchesKey(data,'tab')&&options.onTab){void options.onTab().then(()=>this.render()).catch(e=>this.note(e.message,true));return;}
          if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'enter') || matchesKey(data, 'escape') || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) list.handleInput(data);
          else { input.handleInput(data); list.setFilter(input.getValue()); }
          this.render();
        },
      };
      return component;
    });
  }
  async effortMenu(options){
    try{return await this.interact('',({resolve,cancel})=>new EffortPanel(this,{...options,resolve,cancel}));}
    finally{this.effortPreview=null;this.syncMotion();this.render();}
  }
  async statsMenu(refresh){return this.interact('',({resolve,cancel})=>new StatsPanel(this,{resolve,cancel,refresh}),undefined,{overlay:true});}
  async ask(prompt) {
    if (prompt.type === 'select') return this.choose(prompt.message, prompt.options.map(o => ({ value: o.id, label: o.label, description: o.description })));
    return this.interact(prompt.message, ({ resolve, cancel }) => {
      const input = prompt.type === 'secret' ? new SecretInput(resolve, cancel) : new Input({ prompt: '  › ', placeholder: prompt.placeholder || '' });
      input.onSubmit = resolve; input.onEscape = cancel; return input;
    }, prompt.signal);
  }
  interact(title, make, signal, {overlay=false}={}) {
    if(this.closed)return Promise.resolve(null);
    if (this.pending) throw new Error('Finish the current selection first.');
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      let settled=false,handle;
      const finish = value => {
        if(settled)return;settled=true;handle?.hide();signal?.removeEventListener('abort', cancel); this.pending = null; this.panel.clear(); this.editor.disableSubmit = false; this.tui.setFocus(this.editor); this.render(); resolve(value);
      };
      const cancel = () => finish(null);
      this.pending = { cancel }; signal?.addEventListener('abort', cancel, { once: true });
      if(title)this.panel.addChild(new Text(`  ${bold(safe(title))}`, 0, 1));
      const component = make({ resolve: finish, cancel });
      if(overlay)handle=this.tui.showOverlay(component,{width:'100%',maxHeight:'100%',row:0,col:0,margin:0});else this.panel.addChild(component);
      this.editor.disableSubmit = true; this.tui.setFocus(component); this.render();
    });
  }
  clear() {this.response=null;this.stream=null;this.lastUser=null;this.openTools.clear();this.stopMotion();this.transcript.clear();this.scroll.scrollToEnd();this.tui.resetTextSelection();this.render();}
}
