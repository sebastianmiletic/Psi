import {
  ProcessTerminal, TuiAltScreen, VStack, ScrollView, Container, Text, Markdown, Editor, Input, SelectList,
  CombinedAutocompleteProvider, matchesKey, truncateToWidth, CURSOR_MARKER,
  colorToRgb, parseColor, visibleWidth,
} from '@earendil-works/pi-tui';
import { accentText } from './theme.mjs';
import { usageLabel } from './usage.mjs';
import { PsiHeader, PsiAnimation } from './logo.mjs';
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
  ['project', 'Discover the current Battlecode baseline and controller'], ['settings', 'Appearance, accounts, loop and resource settings'], ['experiments', 'Inspect durable Battlecode experiments'], ['logo', 'Animate the Psi logo'], ['model', 'Choose a provider and model'], ['effort', 'Set reasoning effort'], ['accounts', 'Login, switch or remove accounts'],
  ['provider', 'Add a custom API endpoint'], ['loop', 'Work autonomously toward an objective'], ['stop', 'Stop generation and the active tool wait'],
  ['continue', 'Continue this session'], ['new', 'Start a fresh session'], ['resume', 'Resume a saved session'], ['cd', 'Open another workspace'],
  ['jobs', 'Inspect or stop background jobs'], ['budget', 'Set estimated session cost ceiling, 0 = unlimited'],
  ['limit', 'Set requests per run, 0 = unlimited'], ['tokens', 'Set maximum output tokens'], ['usage', 'Show active account usage and reported limits'], ['tools', 'Show tools available to the AI'], ['cost', 'Show token and estimated cost totals'],
  ['summary-model', 'Choose a cheaper model for compaction'], ['compact', 'Summarize older context'], ['checkpoint', 'Read or write a durable progress note'], ['profile', 'battlecode or general'],
  ['refresh', 'Refresh a provider model catalog'], ['status', 'Show workspace and run settings'], ['export', 'Export this session as Markdown'],
  ['help', 'Show commands'], ['quit', 'Exit Psi; background jobs keep running'],
].map(([name, description]) => ({ name, description }));

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
  constructor(app, { terminal = new ProcessTerminal() } = {}) {
    this.app = app; this.terminal = terminal; this.tui = new TuiAltScreen(terminal);
    this.paint=t=>accentText(t,app.engine.config);
    this.selectionTheme={...selectionTheme,selectedPrefix:this.paint,selectedText:t=>this.paint(bold(t))};
    this.markdownTheme={...markdownTheme,link:this.paint,code:this.paint,listBullet:this.paint};
    this.transcript = new Transcript(); this.panel = new Container(); this.pending = null;
    this.editor = new Editor(this.tui, { borderColor: dim, selectList: this.selectionTheme }, { paddingX: 1, autocompleteMaxVisible: 7 });
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
      const right = truncateToWidth(`thinking ${safe(c.effort)}`, Math.max(0,width-3));
      const left = truncateToWidth(`  ${model}`, Math.max(0,width-visibleWidth(right)-3));
      const gap = Math.max(1,width-visibleWidth(left)-visibleWidth(right)-1);
      return [left+' '.repeat(gap)+dim(right), ...(app.engine.config.showUsage===false?[]:[truncateToWidth('  '+dim(safe(usageLabel(app.activeAccount,app.activeUsage,{sessionCost:app.session.meteredCost,costKnown:app.session.meteredCostKnown}))),width)])];
    } };
    this.scroll = new ScrollView(this.transcript, { follow: 'end', primary: true, scrollbar: 'auto' });
    this.panelScroll = new ScrollView(this.panel, { follow: 'end', scrollbar: 'auto' });
    this.layout = new VStack([
      { component: this.header, basis: 'auto', shrink: 1, minSize: 0, visible: viewport => viewport.height >= 14 && app.engine.config.showLogo!==false && !this.pending },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: this.panelScroll, basis: 'auto', shrink: 1, minSize: 0 },
      { component: this.editor, basis: 'auto', shrink: 1, minSize: 3 },
      { component: this.footer, basis: 'auto', shrink: 0, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(this.layout);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (this.logoAnimation && (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d'))) { this.hideLogo(); return { consume: true }; }
      if (matchesKey(data, 'ctrl+c')) {
        if (app.authController) { app.authController.abort(); this.pending?.cancel(); }
        else if (this.pending) this.pending.cancel();
        else if (app.engine.busy) app.engine.stop();
        else void app.close();
        return { consume: true };
      }
      if (matchesKey(data, 'escape') && !this.pending && app.engine.busy) { app.engine.stop(); return { consume: true }; }
      if (matchesKey(data, 'ctrl+d') && !this.pending && !this.editor.getText()) { void app.close(); return { consume: true }; }
    });
  }
  start() {
    this.closed=false;
    this.note('Build, research, benchmark. Pick a model with /model, connect an account with /accounts.\nTools run with full access. /help shows every command.');
    this.tui.start();
  }
  stop() { this.closed=true; this.hideLogo(); clearTimeout(this.renderTimer); this.pending?.cancel(); clearTimeout(this.renderTimer); this.tui.stop(); }
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
  user(text) { this.transcript.addChild(new Text(`  ${this.paint('›')} ${safe(text)}`, 0, 1)); this.render(); }
  markdown(text, label = true) {
    if (label) this.transcript.addChild(new Text(`  ${this.paint('Ψ')}`, 0, 0));
    const component = new Markdown(safe(text), 2, 1, this.markdownTheme); this.transcript.addChild(component); this.render(); return component;
  }
  event(event) {
    if(this.closed)return;
    if(event.type==='settings_queued')this.note('Settings saved for the next model/tool boundary.');
    if(event.type==='settings'){this.tui.invalidate();this.tui.requestRender(true);}
    if(event.type==='waiting')this.note(event.reason+' · /stop ends the loop; /settings or /accounts can resolve the wait.');
    if(event.type==='account_switched')this.note(`Switched account: ${event.previous} → ${event.account.name}`);
    if(event.type==='model_fallback')this.note(`Using configured fallback: ${event.model}`);
    if(event.type==='account_exhausted')this.note(`${event.account.name}: checking another configured account.`);
    if (event.type === 'request_start') { this.activity = event.summary ? 'compacting' : 'thinking'; this.streamText = ''; this.stream = null; }
    if (event.type === 'text_delta' && !event.summary) {
      if (!this.stream) this.stream = this.markdown('');
      this.activity = 'writing'; this.streamText += event.delta;
      // UI memory is bounded separately from the full session journal.
      this.stream.setText(safe(this.streamText.slice(-100000))); this.render();
    }
    if (event.type === 'tool_start') {
      this.activity = event.call.name;
      const a = event.call.arguments; const detail = a.command || a.path || a.url || a.query || a.action || '';
      this.note(`${event.call.name}  ${String(detail).slice(0, 170)}`);
    }
    if (event.type === 'tool_end') {
      const text = event.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      let display = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'output' in parsed) display = `${parsed.status} · job ${parsed.id}${parsed.exitCode !== undefined ? ` · exit ${parsed.exitCode}` : ''}\n${parsed.output}`;
        else if (parsed?.title && parsed?.url) display = `${parsed.title}\n${parsed.url}\n${parsed.text || ''}`;
      } catch {}
      const preview = display.split('\n').slice(0, 4).join('\n').slice(0, 450);
      this.note(`${event.result.isError ? 'failed' : 'done'} · ${(event.duration / 1000).toFixed(1)}s\n${preview}`, event.result.isError);
    }
    if (event.type === 'retry') this.note(`Provider retry ${event.attempt} in ${(event.delay / 1000).toFixed(1)}s: ${event.error}`, true);
    if (event.type === 'compacted') this.note(`Context compacted: ~${event.before} → ~${event.after} tokens. Full history saved.`);
    if (event.type === 'queued') this.note('Message queued for the next tool boundary.');
    if (event.type === 'stopped') this.note('Stopped. Background jobs continue; use /jobs to stop them.');
    if (event.type === 'error') this.note(event.error, true);
    if (event.type === 'goal_complete') this.note(`Objective complete. ${event.summary}`);
    if (event.type === 'run_end') { this.activity = ''; this.stream = null; }
    this.render();
  }
  async choose(title, items) {
    if (!items.length) { this.note('No items available.'); return null; }
    return this.interact(title, ({ resolve, cancel }) => {
      const input = new Input({ prompt: '  Search: ', placeholder: 'type to filter' });
      input.focused = true;
      const list = new SelectList(items, 9, this.selectionTheme, { minPrimaryColumnWidth: 22, maxPrimaryColumnWidth: 55 });
      list.onSelect = item => resolve(item.value); list.onCancel = cancel;
      const component = {
        focused: true, invalidate() { input.invalidate(); list.invalidate(); },
        render: width => [...input.render(width), '', ...list.render(width), '', dim('  ↑ ↓ choose   enter select   esc back')],
        handleInput: data => {
          if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'enter') || matchesKey(data, 'escape') || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) list.handleInput(data);
          else { input.handleInput(data); list.setFilter(input.getValue()); }
          this.render();
        },
      };
      return component;
    });
  }
  async ask(prompt) {
    if (prompt.type === 'select') return this.choose(prompt.message, prompt.options.map(o => ({ value: o.id, label: o.label, description: o.description })));
    return this.interact(prompt.message, ({ resolve, cancel }) => {
      const input = prompt.type === 'secret' ? new SecretInput(resolve, cancel) : new Input({ prompt: '  › ', placeholder: prompt.placeholder || '' });
      input.onSubmit = resolve; input.onEscape = cancel; return input;
    }, prompt.signal);
  }
  interact(title, make, signal) {
    if (this.pending) throw new Error('Finish the current selection first.');
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const finish = value => {
        signal?.removeEventListener('abort', cancel); this.pending = null; this.panel.clear(); this.editor.disableSubmit = false; this.tui.setFocus(this.editor); this.render(); resolve(value);
      };
      const cancel = () => finish(null);
      this.pending = { cancel }; signal?.addEventListener('abort', cancel, { once: true });
      this.panel.addChild(new Text(`  ${bold(safe(title))}`, 0, 1));
      const component = make({ resolve: finish, cancel }); this.panel.addChild(component);
      this.editor.disableSubmit = true; this.tui.setFocus(component); this.render();
    });
  }
  clear() { this.transcript.clear(); this.scroll.scrollToEnd(); this.tui.resetTextSelection(); this.render(); }
}
