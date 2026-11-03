import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {download,updateInstallation,version} from '../src/updates.mjs';
import {UpdateProgress,updateWithProgress,previewUpdate} from '../src/update-progress.mjs';
import {accentColor} from '../src/theme.mjs';
import {atomicJSON,readJSON} from '../src/storage.mjs';
const url='https://github.com/sebastianmiletic/Psi/releases/download/v9.0.0/psi-v9.0.0.tar.gz';
async function dir(t){const path=await mkdtemp(join(tmpdir(),'psi-update-test-'));t.after(()=>rm(path,{recursive:true,force:true,maxRetries:5,retryDelay:20}));return path;}
function stream(tty=true,width=76){return{isTTY:tty,columns:width,writes:[],write(text){this.writes.push(text);},get text(){return this.writes.join('');}};}
const reply=(chunks,headers={})=>new Response(new ReadableStream({start(c){for(const b of chunks)c.enqueue(b);c.close();}}),{headers});

test('archive download streams exact bytes to disk with truthful progress and an identical hash',async t=>{
 const path=join(await dir(t),'archive'),chunks=[Buffer.from('Ψ bytes '),Buffer.alloc(1234,98),Buffer.from([0,255,10])],all=Buffer.concat(chunks),events=[];
 const hash=await download(url,path,{fetchImpl:async()=>reply(chunks,{'Content-Length':String(all.length)}),onProgress:e=>events.push(e)});
 assert.equal(hash,createHash('sha256').update(all).digest('hex'));assert.deepEqual(await readFile(path),all);assert.equal(events[0].received,0);assert.equal(events.at(-1).received,all.length);assert.ok(events.every(e=>e.total===all.length));assert.ok(events.every((e,i)=>!i||e.received>=events[i-1].received));if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
});

test('unknown download lengths stay unknown and failed or oversized downloads leave no partial archive',async t=>{
 const root=await dir(t),path=join(root,'archive'),events=[];await download(url,path,{fetchImpl:async()=>reply([Buffer.from('unknown')]),onProgress:e=>events.push(e)});assert.ok(events.every(e=>e.total===null));
 const partial=join(root,'partial');await assert.rejects(download(url,partial,{fetchImpl:async()=>reply([Buffer.from('short')],{'Content-Length':'100'})}),/Incomplete/);assert.equal(await stat(partial).catch(()=>null),null);
 await assert.rejects(download(url,partial,{maxBytes:3,fetchImpl:async()=>reply([Buffer.from('long')])}),/too large/);assert.equal(await stat(partial).catch(()=>null),null);
 let called=false;await assert.rejects(download('https://example.com/archive',partial,{fetchImpl:async()=>{called=true;}}),/Untrusted/);assert.equal(called,false);
 await download(url,partial,{expectedBytes:3,fetchImpl:async()=>reply([Buffer.from('abc')]),onProgress:()=>{throw Error('Broken renderer');}});assert.equal(await readFile(partial,'utf8'),'abc');
});

test('update bar uses saved accent and OVERKILL flow while remaining readable at narrow widths',()=>{
 let now=0;const output=stream(),config={accent:'violet',overkill:true},progress=new UpdateProgress(config,{stream:output,env:{},now:()=>now});
 progress.event({phase:'downloading',version:'9.0.0',received:640000,total:1000000});const a=progress.lines(76).join('\n');assert.doesNotMatch(stripTerminalSequences(a),/OVERKILL|Preview/);assert.match(stripTerminalSequences(a),/64%/);assert.match(stripTerminalSequences(a),/640 KB \/ 1.0 MB/);assert.match(stripTerminalSequences(a),/█/);
 const color=accentColor(config);assert.ok(a.includes(`38;2;${color.r};${color.g};${color.b}`));now=700;assert.notEqual(progress.lines(76).join('\n'),a);
 for(const width of[12,20,40,76])assert.ok(progress.lines(width).every(line=>visibleWidth(line)<width));
 progress.event({phase:'installing',received:0,total:null});assert.doesNotMatch(stripTerminalSequences(progress.lines(76).join('\n')),/\d+%/);progress.stop();
});

test('reduced motion is static, starts no timer, and cleans up its owned terminal rows',()=>{
 const output=stream(),config={accent:'#ff9a65',overkill:true,animations:false};let now=1000,timers=0;
 const progress=new UpdateProgress(config,{stream:output,env:{},now:()=>now,setIntervalImpl:()=>{timers++;}});progress.start();progress.event({phase:'downloading',received:10,total:100});const a=progress.lines(76);now+=400;assert.deepEqual(progress.lines(76),a);assert.equal(timers,0);progress.stop();const writes=output.writes.length;progress.stop();progress.event({phase:'installing'});assert.equal(output.writes.length,writes);assert.match(output.text,/\x1b\[2K/);assert.doesNotMatch(output.text,/\x1b\[\?25l/);
});

test('animation is bounded, never adds waiting time and stops on failure',async()=>{
 const output=stream();let tick,cleared=0,interval;
 const progress=new UpdateProgress({overkill:true},{stream:output,env:{},setIntervalImpl:(fn,ms)=>{tick=fn;interval=ms;return{unref(){}};},clearIntervalImpl:()=>cleared++});progress.start();assert.equal(interval,80);tick();progress.stop();assert.equal(cleared,1);
 const errorStream=stream();await assert.rejects(updateWithProgress('/unused',{accent:'cyan'},{stream:errorStream,env:{},output:stream(false),update:async(_,options)=>{options.onProgress({phase:'installing'});throw Error('Install failed');}}),/Install failed/);assert.match(errorStream.text,/Installing/);assert.match(errorStream.text,/Update failed/);assert.ok(errorStream.text.endsWith('\n'));
});

test('redirected output has concise plain stages, JSON stays machine readable, and NO_COLOR removes colour',async()=>{
 const output=stream(false),messages=stream(false);const update=async(_,options)=>{for(const phase of['checking','downloading','downloading','installing','done'])options.onProgress({phase,received:50,total:100});return{updated:true,message:'Updated to 9.0.0. Restart Psi.'};};
 await updateWithProgress('/unused',{overkill:true},{stream:output,output:messages,env:{},update});assert.doesNotMatch(output.text,/\x1b/);assert.equal(output.text.split('Downloading').length-1,1);assert.match(messages.text,/Updated to 9.0.0/);
 const jsonOut=stream(false),jsonStatus=stream();await updateWithProgress('/unused',{}, {stream:jsonStatus,output:jsonOut,json:true,env:{},update});assert.equal(jsonStatus.text,'');assert.equal(JSON.parse(jsonOut.text).updated,true);
 const plain=new UpdateProgress({accent:'rose',overkill:true},{stream:stream(),env:{NO_COLOR:'1'}});assert.doesNotMatch(plain.lines().join('\n'),/\x1b/);
 const dumb=new UpdateProgress({}, {stream:stream(),env:{TERM:'dumb'}});dumb.start();dumb.event({phase:'checking'});dumb.stop();assert.doesNotMatch(dumb.stream.text,/\x1b/);
});

test('complete staged updates emit phases in order, preserve rollback, and progress failures cannot alter activation',async t=>{
 const home=await dir(t),root=join(home,'app'),old={root,current:join(root,'old'),version:'0.0.1'},events=[];await atomicJSON(join(home,'installation.json'),old);const hash='a'.repeat(64),release={available:true,latest:'9.0.0',assets:[{name:'psi-v9.0.0.tar.gz',url,digest:'sha256:'+hash,size:100}]};
 const runImpl=async(command,args)=>{if(command==='git')throw Error('Not a checkout');if(command==='tar'){const target=args[args.indexOf('-C')+1];await mkdir(join(target,'bin'));await atomicJSON(join(target,'package.json'),{version:'9.0.0'});await writeFile(join(target,'bin','psi.mjs'),'// fixture');}return'';};
 const result=await updateInstallation(home,{root,release,runImpl,downloadImpl:async(_,path,options)=>{assert.equal(options.expectedBytes,100);options.onProgress({received:50,total:100});return hash;},onProgress:e=>{events.push(e);if(e.phase==='verifying')throw Error('Renderer failed');}});assert.equal(result.updated,true);assert.equal((await readJSON(join(home,'installation.json'))).version,'9.0.0');
 const phases=events.map(e=>e.phase);for(const phase of['checking','downloading','verifying','extracting','installing','activating','done'])assert.ok(phases.includes(phase));assert.ok(phases.indexOf('verifying')<phases.indexOf('activating'));assert.equal(events.find(e=>e.phase==='downloading'&&e.received===50).total,100);
});

test('success leaves the completed bar in terminal scrollback and current checks do not invent a download',async()=>{
 const display=stream(),out=stream(false);await updateWithProgress('/unused',{accent:'cyan',overkill:true},{stream:display,output:out,env:{},update:async(_,options)=>{options.onProgress({phase:'installing'});return{updated:true,message:'Updated to 9.0.0.'};}});
 assert.match(display.text,/100%/);assert.ok(display.text.endsWith('\n'));assert.match(stripTerminalSequences(display.text),/Ready/);assert.doesNotMatch(display.text.slice(display.text.lastIndexOf('Ready')),/\x1b\[2A\r$/);
 const current=stream();await updateWithProgress('/unused',{}, {stream:current,output:stream(false),env:{},update:async()=>({updated:false,message:'Already current.'})});assert.match(stripTerminalSequences(current.text),/Up to date/);assert.doesNotMatch(stripTerminalSequences(current.text),/100%/);
});

test('explicit preview displays the saved theme and stages without contacting or installing a release',async t=>{
 const home=await dir(t),display=stream(),out=stream(false);await atomicJSON(join(home,'installation.json'),{version:'0.0.1'});const before=await readFile(join(home,'installation.json'),'utf8');let waits=0;
 const result=await previewUpdate(home,{accent:'rose',overkill:true},{stream:display,output:out,env:{},pause:async()=>{waits++;}});assert.equal(result.preview,true);assert.equal(result.updated,false);assert.ok(waits>0);assert.doesNotMatch(stripTerminalSequences(display.text),/Preview|OVERKILL/);assert.match(stripTerminalSequences(display.text),/Downloading/);assert.match(stripTerminalSequences(display.text),/100%/);assert.equal(out.text,'');assert.equal(await readFile(join(home,'installation.json'),'utf8'),before);assert.equal(await stat(join(home,'update.lock')).catch(()=>null),null);
});

test('the actual CLI preview is repeatable and preserves installed state without release lookup',async t=>{
 const home=await dir(t),state={root:join(home,'app'),version:'0.0.1'};await atomicJSON(join(home,'installation.json'),state);
 const cli=fileURLToPath(new URL('../bin/psi.mjs',import.meta.url));let out='',error='';const child=spawn(process.execPath,[cli,'update','--preview','--json'],{env:{...process.env,PSI_HOME:home},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);
 const code=await new Promise((accept,reject)=>{child.once('exit',accept);child.once('error',reject);});assert.equal(code,0,error);assert.equal(JSON.parse(out).preview,true);assert.equal(error,'');assert.deepEqual(await readJSON(join(home,'installation.json')),state);assert.equal(await stat(join(home,'update-check.json')).catch(()=>null),null);assert.equal(await stat(join(home,'update.lock')).catch(()=>null),null);
});

test('download fill and meter width stay stable across percentages and subsequent installation stages',()=>{
 const display=stream(),p=new UpdateProgress({accent:'cyan',overkill:true},{stream:display,env:{},now:()=>0});
 const meter=width=>stripTerminalSequences(p.lines(width)[2]).match(/[█░─]+/)[0];
 for(const width of[24,36,76]){
  let size;
  for(const received of[0,9,10,50,99,100]){p.event({phase:'downloading',received,total:100});const bar=meter(width);size??=bar.length;assert.equal(bar.length,size);assert.equal([...bar].filter(c=>c==='█').length,Math.floor(size*received/100));}
  for(const phase of['verifying','extracting','installing','activating']){p.event({phase});assert.equal(meter(width),'█'.repeat(size));assert.doesNotMatch(stripTerminalSequences(p.lines(width).join('\n')),/\d+%/);}
 }
 p.stop();
});
