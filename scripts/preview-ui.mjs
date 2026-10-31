// Render the real terminal frame to documentation images, with no external model calls.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { App } from '../src/app.mjs';
import { Session } from '../src/session.mjs';
import { defaults } from '../src/storage.mjs';
import { TerminalUI } from '../src/ui.mjs';
import { MemoryTerminal } from '../test/terminal.mjs';
const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function htmlLine(line) {
  let fg='#d7e2dc',bg='transparent',weight='normal',opacity=1, result='';
  for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      const codes = part.slice(2,-1).split(';').map(Number);
      for (let i=0;i<codes.length;i++) {
        const c=codes[i];
        if (c===0) { fg='#d7e2dc';bg='transparent';weight='normal';opacity=1; }
        else if (c===1) weight='bold'; else if(c===2) opacity=0.65; else if(c===22) {weight='normal';opacity=1;}
        else if (c===39) fg='#d7e2dc'; else if(c===49) bg='transparent';
        else if ((c===38||c===48)&&codes[i+1]===2) { const color=`rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; if(c===38)fg=color;else bg=color;i+=4; }
        else if(c===7) {const previous=fg;fg='#18221d';bg=previous;} else if(c===27) {fg='#d7e2dc';bg='transparent';}
      }
    } else if(part) result+=`<span style="display:inline-block;vertical-align:top;height:22px;color:${fg};background:${bg};font-weight:${weight};opacity:${opacity}">${escape(part.replace(/\x1b[_\]][\s\S]*?(?:\x07|\x1b\\)/g,''))}</span>`;
  }
  return result;
}
const home=await mkdtemp(join(tmpdir(),'psi-preview-')); let app,ui,browser;
try {
  const session=await Session.create('/workspace/battlecode',home); app=new App({...defaults,debug:false},session,{home});
  const terminal=new MemoryTerminal(100,32);ui=new TerminalUI(app,{terminal,now:()=>1400});app.ui=ui;ui.start();ui.tui.renderNow();
  browser=await chromium.launch({executablePath:process.env.PSI_CHROME_PATH||'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});
  const page=await browser.newPage({viewport:{width:1040,height:744},deviceScaleFactor:2});
  await mkdir(new URL('../docs/',import.meta.url),{recursive:true});
  for (const [name,animation] of [['terminal',false],['logo-3d',true],['settings',false],['conversation',false],['models',false],['effort',false],['stats',false],['reset',false],['tools',false],['subagents',false],['overkill',false]]) {
    let settings;
    if(name==='models'){ui.clear();settings=app.selectModel('5.6 luna');await new Promise(r=>setTimeout(r,10));}
    if(name==='reset'){ui.clear();const now=Date.now();const data={account:{id:'preview',name:'Personal',provider:'openai-codex',type:'oauth'},mode:'codex',credits:{availableCount:2,credits:[{status:'available',expiresAt:now/1000+10*86400}]},usage:{limits:[{kind:'quota',label:'5h',usedPercent:91,resetAt:now/1000+5400},{kind:'quota',label:'7d',usedPercent:17,resetAt:now/1000+3*86400}]}};settings=ui.resetMenu({account:data.account,read:async()=>data,use:async()=>data,onUsage:d=>{app.activeAccount=d.account;app.activeUsage=d.usage;}});await new Promise(r=>setTimeout(r,0));}
    if(name==='tools'){ui.clear();settings=ui.toolsMenu(app.tools.definitions());}
    if(name==='subagents'){ui.clear();settings=app.agentsMenu();await new Promise(r=>setTimeout(r,5));}
    if(name==='effort'){ui.clear();settings=ui.effortMenu({levels:['off','low','medium','high','xhigh','max'],effort:'medium',overkill:true});}
    if(name==='stats'){ui.clear();const now=Date.now();const days={};for(let i=0;i<112;i++){const d=new Date(now);d.setDate(d.getDate()-i);days[`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`]=i%11===0?0:((i*7919)%140000);}const data=['week','month','all'].map((period,i)=>{const tokens=[286400,1283000,4821000][i];return{period,now,tokens,input:tokens*0.45,output:tokens*0.2,cacheRead:tokens*0.35,cachePercent:44,requests:[34,186,642][i],sessions:[5,24,87][i],workers:[9,41,138][i],tools:[206,984,3612][i],goals:[3,18,61][i],activeMs:[9600000,48600000,168200000][i],agentMs:[16400000,89100000,296100000][i],providers:{'openai-codex':{tokens:tokens*0.74,requests:400},anthropic:{tokens:tokens*0.26,requests:242}},days,unknownDatedRequests:0,malformed:0};});settings=ui.statsMenu(async()=>data);await new Promise(r=>setTimeout(r,0));}
    if(name==='overkill'){ui.clear();app.engine.config.overkill=true;ui.syncMotion();ui.editor.setText('Compare the next experiment.');for(const [i,name,activity,status]of[[1,'Replay audit · Research','read','running'],[2,'Fixture risks · Review','reasoning','running'],[3,'Build approach · Builder',null,'completed']])ui.event({type:'agent_status',agent:{id:'preview-'+i,name,activity,status,model:'openai-codex/gpt-5.6-luna',createdAt:new Date(Date.now()-45000).toISOString()}});}
    if(name==='settings'){ui.hideLogo();settings=app.settingsMenu();}
    if(name==='conversation'){
      ui.clear();ui.user('Verify the baseline and check the next experiment.',{animate:false});
      ui.markdown('I’ll inspect the source identity and paired fixtures, then run the checks.');
      for(const [i,name,args]of[[1,'read',{path:'bots/vision-v6/manifest.json'}],[2,'search',{pattern:'confirmation',path:'tools/vision'}]]){
        const call={id:'preview-'+i,name,arguments:args};ui.event({type:'tool_start',call});ui.event({type:'tool_end',call,result:{isError:false,content:[{type:'text',text:'Baseline source and fixture evidence verified.'}]}});
      }
      const call={id:'preview-check',name:'bash',arguments:{command:'python3 -m unittest discover -s tests'}};
      ui.event({type:'tool_start',call});ui.event({type:'tool_end',call,duration:1600,result:{isError:false,content:[{type:'text',text:JSON.stringify({status:'completed',exitCode:0,output:'Ran 9 tests in 1.6s\nOK'})}]}});
      ui.markdown('Baseline verified. The candidate stays separate from the incumbent.\n\n- Source hashes match the frozen manifest.\n- Both fixture sides are present.\n- All 9 correctness checks passed.');
      app.activeAccount={name:'Personal',type:'oauth',billingMode:'subscription'};app.activeUsage={limitsAt:new Date().toISOString(),limits:[{kind:'quota',label:'5h',usedPercent:31,resetAt:9999999999},{kind:'quota',label:'7d',usedPercent:17,resetAt:9999999999}]};
      session.state.progress={percent:64};ui.editor.setText('Compare both sides before changing the strategy.');
    }
    if(animation) { ui.showLogo(); ui.logoAnimation.started-=520; }
    ui.tui.renderNow();
    const lines=ui.tui.getScreenLines();
    await page.setContent(`<html><style>body{margin:0;padding:20px;background:#18221d}pre{margin:0;font:16px/22px Menlo,monospace;white-space:pre}</style><body><pre>${lines.map(htmlLine).join('\n')}</pre></body></html>`);
    await page.screenshot({path:fileURLToPath(new URL(`../docs/${name}.png`,import.meta.url))});
    if(settings){ui.pending?.cancel();await settings;}
  }
  console.log('Rendered terminal, conversation, effort, stats and OVERKILL previews from actual terminal frames.');
} finally {ui?.stop();await app?.close();await browser?.close();await rm(home,{recursive:true,force:true});}
