import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './helpers.mjs';
import {TerminalUI} from '../src/ui.mjs';
import {MemoryTerminal} from './terminal.mjs';
import {stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {version,updateInstallation,checkUpdate} from '../src/updates.mjs';
import {atomicJSON,readJSON} from '../src/storage.mjs';
test('version and pending update stay in the pinned header, including compact menus and offline state',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();f.app.updateInfo={latest:'9.0.0',available:true};
 for(const width of[28,48,100]){const lines=ui.header.render(width).map(stripTerminalSequences);assert.match(lines.join('\n'),new RegExp('Ψ  v'+version.replaceAll('.','\\.')));assert.match(lines.join('\n'),/v9.0.0 available/);assert.doesNotMatch(lines.join('\n'),/Ψ\s+Psi/);assert.ok(lines.every(l=>visibleWidth(l)<=width));}
 f.app.updateInfo.installed=true;assert.match(ui.header.render(100).map(stripTerminalSequences).join('\n'),/installed · restart/);
 f.app.updateInfo={latest:version};assert.doesNotMatch(ui.header.render(100).map(stripTerminalSequences).join('\n'),/available|installed/);
});
test('updater prepares verified releases before activation and leaves active state unchanged on checksum or dependency failures',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),home=f.app.home,root=join(f.root,'managed'),old={root,current:join(root,'old'),version:'0.0.1'};await atomicJSON(join(home,'installation.json'),old);const digest='a'.repeat(64),release={available:true,latest:'9.0.0',assets:[{name:'psi-v9.0.0.tar.gz',url:'https://github.com/sebastianmiletic/Psi/releases/download/v9.0.0/psi-v9.0.0.tar.gz',digest:'sha256:'+digest}]};
 const runImpl=async(command,args,cwd)=>{if(command==='git')throw new Error('not git');if(command==='tar'){const target=args[args.indexOf('-C')+1];await mkdir(join(target,'bin'));await atomicJSON(join(target,'package.json'),{version:'9.0.0'});await writeFile(join(target,'bin','psi.mjs'),'// fixture');}if(command==='npm')throw new Error('install failed');return '';};
 await assert.rejects(updateInstallation(home,{root,release,runImpl,downloadImpl:async()=> 'b'.repeat(64)}),/checksum/);assert.deepEqual(await readJSON(join(home,'installation.json')),old);
 await assert.rejects(updateInstallation(home,{root,release,runImpl,downloadImpl:async()=>digest}),/install failed/);assert.deepEqual(await readJSON(join(home,'installation.json')),old);
 const successful=async(command,args,cwd)=>{if(command==='npm')return'';return runImpl(command,args,cwd);};
 assert.equal((await updateInstallation(home,{root,release,runImpl:successful,downloadImpl:async()=>digest})).updated,true);assert.equal((await readJSON(join(home,'installation.json'))).version,'9.0.0');
});
test('dirty source updates preserve edited files and replace only their own launcher',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,()=>({text:'unused'})),source=join(f.root,'source'),target=join(f.root,'bin','psi');await mkdir(join(source,'bin'),{recursive:true});await mkdir(join(f.root,'bin'));await writeFile(join(source,'bin','psi.mjs'),'// source');await writeFile(join(source,'custom.txt'),'user edits');await symlink(join(source,'bin','psi.mjs'),target);
 const digest='a'.repeat(64),release={available:true,latest:'9.0.0',assets:[{name:'psi-v9.0.0.tar.gz',url:'https://github.com/sebastianmiletic/Psi/releases/download/v9.0.0/psi-v9.0.0.tar.gz',digest:'sha256:'+digest}]};
 const runImpl=async(command,args)=>{if(command==='git')return args[0]==='remote'?'https://github.com/sebastianmiletic/Psi.git':' M custom.txt';if(command==='tar'){const dir=args.at(-1);await mkdir(join(dir,'bin'));await atomicJSON(join(dir,'package.json'),{version:'9.0.0'});await writeFile(join(dir,'bin','psi.mjs'),'// release');}return'';};
 const result=await updateInstallation(f.app.home,{root:source,release,runImpl,downloadImpl:async()=>digest,launcherTarget:target});assert.equal(result.updated,true);assert.equal(await readFile(join(source,'custom.txt'),'utf8'),'user edits');assert.match(await readFile(target,'utf8'),/launcher.cjs/);assert.equal((await readJSON(join(f.app.home,'installation.json'))).version,'9.0.0');
});


test('complete interactive startup restores the draft/history and shows the cached update command',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32);
 f.app.options.terminal=terminal;await f.app.update({checkForUpdates:false,autoUpdate:false});
 await f.session.message({role:'user',content:'Inspect the saved workspace',timestamp:Date.now()});
 await f.session.event({type:'state',state:{composerDraft:'Keep this unsent draft'}});
 await atomicJSON(join(f.app.home,'update-check.json'),{latest:'9.0.0',available:true,checkedAt:Date.now()});
 await f.app.startUI();f.app.ui.tui.renderNow();
 const frame=f.app.ui.tui.getScreenLines().map(stripTerminalSequences).join('\n');
 assert.match(frame,/Ψ  v/);assert.match(frame,/v9.0.0 available · psi update/);assert.match(frame,/Inspect the saved workspace/);
 assert.equal(f.app.ui.editor.getText(),'Keep this unsent draft');assert.equal(f.requests.length,0);
});


test('startup checks for a fresh release and retains known notices when offline',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));f.app.options.terminal=new MemoryTerminal(100,32);await f.app.update({checkForUpdates:true,autoUpdate:false});
 await writeFile(join(f.app.home,'update-check.json'),'bad cached JSON');
 let checked;f.app.options.checkUpdate=async(_home,options)=>{checked=options;return{latest:'9.0.0',available:true};};
 await f.app.startUI();assert.deepEqual(checked,{force:true});
 f.app.options.checkUpdate=async()=>{throw new Error('Offline fixture');};
 await f.app.checkUpdates({force:true});assert.equal(f.app.updateInfo.latest,'9.0.0');
 assert.match(f.app.ui.header.render(100).map(stripTerminalSequences).join('\n'),/v9.0.0 available · psi update/);
 assert.equal(f.requests.length,0);
});

test('startup failure after raw mode closes the terminal and preserves the saved chat',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),terminal=new MemoryTerminal(100,32);f.app.options.terminal=terminal;
 await f.session.message({role:'user',content:'Keep the saved work',timestamp:Date.now()});
 f.app.agents.restore=async()=>{throw new Error('Fixture restore failure');};
 await assert.rejects(f.app.startUI(),/Fixture restore failure/);
 assert.equal(f.app.ui.closed,true);assert.equal(terminal.onInput,null);assert.equal(f.app.closing,true);
 assert.match(await readFile(join(f.session.dir,'events.jsonl'),'utf8'),/Keep the saved work/);assert.equal(f.requests.length,0);
});


test('a damaged update cache cannot prevent fresh release detection',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await writeFile(join(f.app.home,'update-check.json'),'incomplete cache');let calls=0;
 const update=await checkUpdate(f.app.home,{force:true,fetchImpl:async()=>{calls++;return{ok:true,status:200,json:async()=>({tag_name:'v9.0.0',html_url:'https://github.com/sebastianmiletic/Psi/releases/tag/v9.0.0',assets:[]})};}});
 assert.equal(calls,1);assert.equal(update.latest,'9.0.0');assert.equal(update.available,true);assert.equal((await readJSON(join(f.app.home,'update-check.json'))).latest,'9.0.0');
});
