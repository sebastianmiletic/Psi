import {setTimeout as delay} from 'node:timers/promises';
import {truncateToWidth,visibleWidth} from '@earendil-works/pi-tui';
import {accentText,accentFlow} from './theme.mjs';
import {cleanTerminal,redact} from './storage.mjs';
import {updateInstallation,version} from './updates.mjs';
const stages={waiting:'Waiting for updater',checking:'Checking updates',preparing:'Preparing',fetching:'Fetching release',downloading:'Downloading',verifying:'Verifying',extracting:'Unpacking',installing:'Installing',activating:'Finishing',done:'Ready',current:'Up to date',failed:'Update failed'};
const dim=text=>`\x1b[2m${text}\x1b[22m`;
const bytes=value=>value>=1e6?`${(value/1e6).toFixed(1)} MB`:value>=1000?`${Math.round(value/1000)} KB`:`${value} B`;

export class UpdateProgress{
  constructor(config={}, {stream=process.stderr,env=process.env,now=()=>Date.now(),setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}){
    Object.assign(this,{config,stream,env,now,setIntervalImpl,clearIntervalImpl});
    this.interactive=!!stream.isTTY&&env.TERM!=='dumb';this.color=this.interactive&&env.NO_COLOR===undefined;
    this.state={phase:'checking',current:version};this.rendered=false;this.started=false;
  }
  paint(text,flow=false,offset=0){return !this.color?text:flow&&this.config.overkill?accentFlow(text,this.config,{time:this.now(),offset}):accentText(text,this.config);}
  lines(width=this.stream.columns||80){
    const room=Math.max(1,width-1),inner=Math.max(1,Math.min(56,room-2)),s=this.state;
    const identity=`${this.config.showLogo===false?'':'Ψ  '}v${s.current||version}${s.version&&s.version!==s.current?' → v'+s.version:''}`;
    const header='  '+this.paint(identity),label=stages[s.phase]||'Updating';
    const moving=this.config.animations!==false,spinner=moving?'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(this.now()/80)%10]:'·';
    const detail=s.phase==='downloading'&&Number.isFinite(s.received)?`${bytes(s.received)}${s.total?' / '+bytes(s.total):''}`:'';
    const title=(s.phase==='failed'?'!':s.phase==='done'||s.phase==='current'?'✓':spinner)+' '+label;
    const caption=title+(detail?' '.repeat(Math.max(2,inner-visibleWidth(title)-visibleWidth(detail)))+(this.color?dim(detail):detail):'');
    const percent=s.phase==='downloading'&&s.total>0?Math.min(100,Math.floor(100*s.received/s.total)):s.phase==='done'?100:null;
    // Fixed geometry through every phase and every percentage digit. The bar
    // represents downloaded bytes, so verification/install never reset its fill.
    const suffix=percent===null?'     ':` ${String(percent).padStart(3)}%`,size=Math.max(1,Math.min(44,inner-5));
    const ratio=s.phase==='done'?1:this.download?.total>0?Math.min(1,this.download.received/this.download.total):0;
    let bar;
    if(['current','failed'].includes(s.phase))bar=this.paint('─'.repeat(size));
    else{const filled=Math.floor(size*ratio);bar=this.paint('█'.repeat(filled)+'░'.repeat(size-filled),true);}
    return[header,'  '+caption,'  '+bar+suffix].map(line=>truncateToWidth(line,room));
  }
  draw(){if(this.stopped||!this.interactive)return;const lines=this.lines();this.stream.write((this.rendered?'\r\x1b[2A':'')+lines.map(line=>'\r\x1b[2K'+line).join('\n'));this.rendered=true;this.lastDraw=this.now();}
  event(event){
    if(this.stopped)return;const previousPhase=this.state.phase;this.state={...this.state,...event};
    if(event.phase==='downloading')this.download={received:event.received||0,total:event.total};
    if(this.interactive){if(!this.rendered||previousPhase!==this.state.phase||this.config.animations===false&&this.now()-this.lastDraw>=80)this.draw();}
    else if(event.phase!==this.logged&&stages[event.phase]){this.logged=event.phase;if(!['done','current'].includes(event.phase))this.stream.write(stages[event.phase]+'\n');}
  }
  start(){if(this.started)return;this.started=true;this.draw();if(this.interactive&&this.config.animations!==false){this.timer=this.setIntervalImpl(()=>this.draw(),80);this.timer.unref?.();}}
  finish(result){this.event({phase:result.updated||result.preview?'done':'current'});this.stop({preserve:true});}
  fail(){this.event({phase:'failed'});this.stop({preserve:true});}
  stop({preserve=false}={}){if(this.stopped)return;this.stopped=true;if(this.timer!==undefined)this.clearIntervalImpl(this.timer);if(this.rendered&&preserve)this.stream.write('\n');else if(this.rendered)this.stream.write('\r\x1b[2A\r\x1b[2K\n\r\x1b[2K\n\r\x1b[2K\x1b[2A\r');}
}

export async function updateWithProgress(home,config,{stream=process.stderr,output=process.stdout,json=false,update=updateInstallation,...options}={}){
  const progress=new UpdateProgress(config,{stream,...options});
  if(!json)progress.start();
  try{
    const result=await update(home,{onProgress:event=>{if(!json)progress.event(event);}});
    if(!json)progress.finish(result);if(json)output.write(JSON.stringify(result)+'\n');else if(result.message&&!result.preview)output.write(cleanTerminal(redact(result.message))+'\n');return result;
  }catch(error){if(!json)progress.fail();throw error;}finally{progress.stop();}
}

// Explicit visual preview only. The actual updater never waits for animation.
export async function previewUpdate(home,config,{pause=delay,...options}={}){
  return updateWithProgress(home,config,{...options,preview:true,update:async(_, {onProgress})=>{
    onProgress({phase:'checking'});await pause(100);
    const total=6400000;
    for(let step=0;step<=12;step++){onProgress({phase:'downloading',received:Math.round(total*step/12),total});await pause(50);}
    for(const phase of ['verifying','installing','activating']){onProgress({phase});await pause(100);}
    return{updated:false,preview:true,message:''};
  }});
}
