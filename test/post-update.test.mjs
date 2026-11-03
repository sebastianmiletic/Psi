import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {runUpdatedPsi,maybeOpenAfterUpdate} from '../src/post-update.mjs';
import {defaults,loadConfig,atomicJSON,readJSON} from '../src/storage.mjs';
import {settingItems,validateSettings} from '../src/settings.mjs';
import {updateInstallation} from '../src/updates.mjs';
import {Session} from '../src/session.mjs';
import {fixture} from './helpers.mjs';
import {MemoryTerminal} from './terminal.mjs';

test('open after update defaults off and the Settings toggle persists both states',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));assert.equal(defaults.openAfterUpdate,false);assert.equal((await loadConfig(f.app.home)).openAfterUpdate,false);assert.equal(settingItems.find(i=>i.id==='openAfterUpdate').boolean,true);assert.throws(()=>validateSettings({openAfterUpdate:'yes'}),/on or off/);
 for(const enabled of[true,false]){const answers=['openAfterUpdate',null];f.app.ui={choose:async()=>answers.shift(),render(){},note(){},event(){},stop(){}};await f.app.settingsMenu();assert.equal((await loadConfig(f.app.home)).openAfterUpdate,enabled);assert.equal(f.app.engine.config.openAfterUpdate,enabled);}
 assert.equal(f.requests.length,0);
});

test('only successful opted-in interactive updates open the new version',async()=>{
 const entrypoint=join(tmpdir(),'new-psi','bin','psi.mjs'),result={updated:true,entrypoint},calls=[];
 const open=async options=>{calls.push(options);return 7;};
 for(const [r,c,options]of[[result,{},{}],[{updated:false},{openAfterUpdate:true},{}],[{...result,preview:true},{openAfterUpdate:true},{}],[result,{openAfterUpdate:true},{json:true}],[result,{openAfterUpdate:true},{interactive:false}]])assert.deepEqual(await maybeOpenAfterUpdate(r,c,{open,interactive:true,...options}),{opened:false});
 assert.equal(calls.length,0);assert.deepEqual(await maybeOpenAfterUpdate(result,{openAfterUpdate:true},{open,interactive:true}),{opened:true,exitCode:7});assert.equal(calls[0].entrypoint,entrypoint);
});

test('the updated entrypoint runs with inherited terminal IO, directory and home and its exit code is retained',async t=>{
 const root=await mkdtemp(join(tmpdir(),'psi-post-update-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));const entrypoint=join(root,'psi.mjs'),output=join(root,'result.json'),home=join(root,'home');
 await writeFile(entrypoint,"import{writeFileSync}from'node:fs';writeFileSync(process.env.PSI_REOPEN_RESULT,JSON.stringify({cwd:process.cwd(),home:process.env.PSI_HOME,args:process.argv.slice(2)}));process.exit(7);\n");
 const code=await runUpdatedPsi({entrypoint,args:['--resume','saved-chat'],cwd:root,env:{...process.env,PSI_HOME:home,PSI_REOPEN_RESULT:output},signals:new EventEmitter()});assert.equal(code,7);const saved=JSON.parse(await readFile(output));assert.equal(saved.home,home);assert.deepEqual(saved.args,['--resume','saved-chat']);assert.equal(await import('node:fs/promises').then(fs=>fs.realpath(saved.cwd)),await import('node:fs/promises').then(fs=>fs.realpath(root)));
});

test('the waiting parent preserves terminal signal ownership and cleans listeners on exit or spawn failure',async()=>{
 const signals=new EventEmitter(),child=new EventEmitter(),killed=[];child.kill=signal=>killed.push(signal);let options;
 const running=runUpdatedPsi({entrypoint:join(tmpdir(),'psi.mjs'),signals,spawnImpl:(command,args,opts)=>{options=opts;assert.equal(command,process.execPath);return child;}});assert.equal(options.stdio,'inherit');signals.emit('SIGINT');assert.deepEqual(killed,[]);signals.emit('SIGTERM');assert.deepEqual(killed,['SIGTERM']);child.emit('exit',0);assert.equal(await running,0);assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);
 const failed=new EventEmitter();const attempt=runUpdatedPsi({entrypoint:join(tmpdir(),'psi.mjs'),signals,spawnImpl:()=>failed});failed.emit('error',Error('Fixture spawn failed'));await assert.rejects(attempt,/Update installed, but Psi could not open/);assert.equal(signals.listenerCount('SIGINT'),0);
});

test('a clean source update returns its own entrypoint even when another managed installation exists',async t=>{
 const root=await mkdtemp(join(tmpdir(),'psi-source-open-'));t.after(()=>rm(root,{recursive:true,force:true}));const home=join(root,'home'),source=join(root,'source');await mkdir(source);await atomicJSON(join(source,'package.json'),{version:'9.0.0'});const prior={current:join(root,'different-copy'),version:'0.0.1'};await atomicJSON(join(home,'installation.json'),prior);
 const result=await updateInstallation(home,{root:source,release:{available:true,latest:'9.0.0',assets:[]},runImpl:async(command,args)=>args[0]==='remote'?'https://github.com/sebastianmiletic/Psi.git':''});assert.equal(result.entrypoint,join(source,'bin','psi.mjs'));assert.deepEqual(await readJSON(join(home,'installation.json')),prior);
});

test('manual UI updates reopen only when enabled, preserving the exact chat and draft before restarting',async t=>{
 for(const enabled of[false,true]){
  const f=await fixture(t,()=>({text:'unused'}));await f.app.update({openAfterUpdate:enabled,checkForUpdates:false,autoUpdate:false});await f.session.message({role:'user',content:'Preserve this chat',timestamp:1});f.app.options.terminal=new MemoryTerminal(100,32);await f.app.startUI();f.app.ui.editor.setText('Unsent draft');let restarted;
  const entrypoint=join(f.root,'updated','bin','psi.mjs');f.app.options.updateInstallation=async()=>({updated:true,entrypoint,message:'Updated'});f.app.options.onRestart=async options=>{restarted=options;assert.equal(f.app.closing,true);assert.equal(f.app.uiLease,undefined);};await f.app.submit('/update');
  if(enabled){assert.deepEqual(restarted,{sessionId:f.session.meta.id,cwd:f.root,entrypoint});const saved=await Session.load(f.session.meta.id,f.app.home);assert.equal(saved.messages[0].content,'Preserve this chat');assert.equal(saved.state.composerDraft,'Unsent draft');}else{assert.equal(restarted,undefined);assert.equal(f.app.closing,undefined);}
  assert.equal(f.requests.length,0);
 }
});

test('current, failed and active-run manual updates never restart',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.app.update({openAfterUpdate:true});let opens=0,updates=0;f.app.ui={note(){},render(){},stop(){}};f.app.options.onRestart=async()=>opens++;
 f.app.options.updateInstallation=async()=>{updates++;return{updated:false,message:'Current'};};await f.app.submit('/update');assert.equal(opens,0);
 f.app.options.updateInstallation=async()=>{updates++;throw Error('Fixture update failed');};await assert.rejects(f.app.submit('/update'),/Fixture update failed/);assert.equal(opens,0);
 f.app.engine.busy=true;try{await assert.rejects(f.app.submit('/update'),/Stop the active run/);}finally{f.app.engine.busy=false;}assert.equal(updates,2);assert.equal(opens,0);
});
