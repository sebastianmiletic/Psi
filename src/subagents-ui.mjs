import {VStack,ScrollView,truncateToWidth} from '@earendil-works/pi-tui';
import {modelLabel} from './model-label.mjs';
import {cleanTerminal,redact} from './storage.mjs';
const safe=value=>cleanTerminal(redact(String(value??'')));
const dim=value=>`\x1b[2m${value}\x1b[22m`;
const groupKey=name=>name.normalize('NFKC').toLowerCase();
export const activeWorker = worker => ['running', 'queued', 'waiting'].includes(worker.status);
export function workerGroups(workers) {
  const groups = new Map();
  for (const worker of workers.filter(activeWorker)) {
    const name = cleanTerminal(worker.group || 'Other tasks').replace(/\s+/g, ' ').trim();
    const key = name.normalize('NFKC').toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, workers: [] });
    groups.get(key).workers.push(worker);
  }
  return [...groups.values()];
}
// Bounded footer, unbounded active registry. Overflow counts include every worker.
export function workerDisplay(workers, maxRows = 3) {
  const active = workers.filter(activeWorker);
  if (!active.length) return [];
  const grouped = active.length > 3;
  const entries = grouped ? workerGroups(active) : active.map(worker => ({ name: worker.name, workers: [worker] }));
  const rows = entries.slice(0, Math.max(1, maxRows));
  const hidden = entries.slice(rows.length).reduce((n, g) => n + g.workers.length, 0);
  return rows.map((entry, i) => ({ ...entry, grouped, hidden: i === rows.length - 1 ? hidden : 0 }));
}

// The expanded list gets its own bounded viewport, leaving the composer usable.
export class SubagentPanel extends VStack {
  constructor(ui) {
    const controls={invalidate(){},render:width=>panel.controls(width),handleMouse:event=>panel.controlMouse(event)};
    const list={invalidate(){},render:width=>panel.lines(width),handleMouse:event=>panel.listMouse(event)};
    const scroll=new ScrollView(list,{follow:'none',overscroll:'contain',scrollbar:'auto'});
    super([{component:controls,basis:'auto',shrink:0,minSize:0},{component:scroll,basis:'auto',shrink:1,minSize:0}]);
    const panel=this;this.ui=ui;this.scroll=scroll;this.expanded=new Set();this.targets=[];
  }
  groups() {
    const groups=workerGroups([...this.ui.workerRows.values()]);
    const present=new Set(groups.map(g=>groupKey(g.name)));
    for(const key of this.expanded)if(!present.has(key))this.expanded.delete(key);
    return groups;
  }
  toggle(key) {
    this.groups();
    if(this.expanded.has(key))this.expanded.delete(key);else this.expanded.add(key);
    this.scroll.scrollToStart();this.ui.tui.invalidate();this.ui.render();
  }
  toggleAll() {
    const groups=this.groups();
    if(this.expanded.size)this.expanded.clear();else for(const group of groups)this.expanded.add(groupKey(group.name));
    this.scroll.scrollToStart();this.ui.tui.invalidate();this.ui.render();
  }
  controls(width) {
    this.groups();
    return this.expanded.size?[truncateToWidth('  '+this.ui.paint('▾ Subagents')+dim(' · collapse'),width)]:[];
  }
  controlMouse(event) {
    if(event.type==='click'&&event.button==='left'){this.expanded.clear();this.scroll.scrollToStart();this.ui.tui.invalidate();this.ui.render();return{handled:true,render:true};}
  }
  listMouse(event) {
    const key=this.targets[event.y];
    if(event.type!=='click'||event.button!=='left'||key===undefined)return;
    if(key===null)this.toggleAll();else this.toggle(key);
    return{handled:true,render:true};
  }
  workerLine(worker,width,indent='  ') {
    const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(worker.createdAt||new Date()))/1000));
    return truncateToWidth(indent+this.ui.paint('●')+' '+safe(worker.name)+' · '+dim(safe(`${worker.activity||worker.status} · ${modelLabel(worker.model)} · ${elapsed}s`)),width);
  }
  lines(width) {
    const groups=this.groups(),active=[...this.ui.workerRows.values()].filter(activeWorker);this.targets=[];
    if(!active.length)return[];
    if(!this.expanded.size){
      const max=Math.max(1,Math.min(3,Math.floor(this.ui.terminal.rows/10)));
      return workerDisplay(active,max).map((entry,i)=>{
        if(!entry.grouped)return this.workerLine(entry.workers[0],width);
        this.targets[i]=entry.hidden?null:groupKey(entry.name);
        const extra=entry.hidden?` · +${entry.hidden} more`:'';
        return truncateToWidth('  '+this.ui.paint('▸')+' '+safe(entry.name)+' · '+dim(safe(`${entry.workers.length} active · ${entry.workers[0].name}${entry.workers.length>1?` +${entry.workers.length-1}`:''}${extra}`)),width);
      });
    }
    const lines=[];
    for(const group of groups){
      const key=groupKey(group.name),open=this.expanded.has(key);this.targets[lines.length]=key;
      lines.push(truncateToWidth('  '+this.ui.paint(open?'▾':'▸')+' '+safe(group.name)+' · '+dim(`${group.workers.length} active`),width));
      if(open)for(const worker of group.workers)lines.push(this.workerLine(worker,width,'    '));
    }
    return lines;
  }
  maxHeight(width) {
    const ui=this.ui,header=ui.app.engine.config.showLogo===false||ui.terminal.rows<10?0:ui.header.render(width).length;
    const reserved=header+Math.min(6,ui.editor.render(width).length)+ui.footer.render(width).length+1+ui.activityLines(width).length+3;
    return Math.max(1,Math.min(Math.floor(ui.terminal.rows/2),ui.terminal.rows-reserved));
  }
  // Bound the stack’s measured height; the nested ScrollView retains every row.
  render(width) {return super.render(width).slice(0,this.maxHeight(width));}
  reset(){this.expanded.clear();this.targets=[];this.scroll.scrollToStart();}
}
