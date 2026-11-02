import { readFile, mkdir, rm, mkdtemp, writeFile,rename,realpath,lstat,access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicJSON, readJSON, withLock } from './storage.mjs';
export const repository='sebastianmiletic/Psi';
export const packageRoot=fileURLToPath(new URL('..',import.meta.url));
export const version=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8')).version;
export const newer=(a,b)=>{const x=a.replace(/^v/,'').split('.').map(Number),y=b.replace(/^v/,'').split('.').map(Number);return x.every(Number.isInteger)&&x.length===3&&x.some((n,i)=>n!==y[i]&&x.slice(0,i).every((v,j)=>v===y[j])&&n>y[i]);};
export function run(command,args,cwd){return new Promise((res,rej)=>{
 if(process.platform==='win32'&&command==='npm'){args=['/d','/s','/c','npm '+args.map(a=>'"'+a.replaceAll('"','')+'"').join(' ')];command=process.env.COMSPEC||'cmd.exe';}
 const p=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',c=>{output=(output+c).slice(-12000)});p.stderr.on('data',c=>{output=(output+c).slice(-12000)});p.on('error',rej);p.on('close',code=>code===0?res(output.trim()):rej(new Error(`${command} failed (${code}): ${output}`)));
});}
export async function checkUpdate(home,{force=false,fetchImpl=fetch}={}){
 const cache=join(home,'update-check.json'),old=await readJSON(cache,null).catch(()=>null);
 if(!force&&old&&Date.now()-old.checkedAt<21600000)return{...old,available:newer(old.latest,version)};
 const response=await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'Psi-updater'},signal:AbortSignal.timeout(6000)});
 if(response.status===404){const result={checkedAt:Date.now(),latest:version,available:false};await atomicJSON(cache,result);return result;}if(!response.ok)throw new Error(`GitHub update check: HTTP ${response.status}`);
 const release=await response.json(),latest=release.tag_name?.replace(/^v/,'');
 if(!/^\d+\.\d+\.\d+$/.test(latest))throw new Error('Invalid release version');
 const result={checkedAt:Date.now(),latest,available:newer(latest,version),url:release.html_url,assets:release.assets.map(a=>({name:a.name,url:a.browser_download_url,digest:a.digest}))};await atomicJSON(cache,result);return result;
}
export async function download(url,path,{maxBytes=50000000}={}){
 if(!/^https:\/\/(?:github\.com|release-assets\.githubusercontent\.com)\//.test(url))throw new Error('Untrusted release URL');
 const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw new Error(`Download failed: HTTP ${r.status}`);
 const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>maxBytes)throw new Error('Release archive too large');chunks.push(c);}const bytes=Buffer.concat(chunks);await writeFile(path,bytes,{mode:0o600});return createHash('sha256').update(bytes).digest('hex');
}
export async function activateManaged(home,installed,{root,launcherTarget=process.platform==='win32'?join(home,'bin','psi.cmd'):join(homedir(),'.local','bin','psi')}={}){
 const current=await lstat(launcherTarget).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(current){
  const linked=await realpath(launcherTarget).catch(()=>null);
  if(!root||linked!==await realpath(join(root,'bin','psi.mjs')).catch(()=>null))throw new Error('Update installed separately, but the launcher belongs to another installation: '+launcherTarget);
 }
 await mkdir(installed.root,{recursive:true});await mkdir(resolve(launcherTarget,'..'),{recursive:true});
 const launcher=join(installed.root,'launcher.cjs'),statePath=join(home,'installation.json');
 await writeFile(launcher,"#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),url=require('node:url');const s=JSON.parse(fs.readFileSync("+JSON.stringify(statePath)+",'utf8'));import(url.pathToFileURL(path.join(s.current,'bin','psi.mjs')).href);\n",{mode:0o755});
 const staged=launcherTarget+'.psi-update-'+process.pid;
 const text=process.platform==='win32'?'@echo off\r\nnode "'+launcher+'" %*\r\n':"#!/bin/sh\nexec node '"+launcher.replaceAll("'","'\\''")+"' \"$@\"\n";
 await writeFile(staged,text,{mode:0o755});
 // All downloads/dependencies are ready before changing the active pointer.
 const previous=await readJSON(statePath,null);
 try{await atomicJSON(statePath,installed);await rename(staged,launcherTarget);}
 catch(e){if(previous)await atomicJSON(statePath,previous);else await rm(statePath,{force:true});throw e;}
 finally{await rm(staged,{force:true});}
}
export async function updateInstallation(home,{release,root=packageRoot,runImpl=run,downloadImpl=download,launcherTarget}={}){
 return withLock(join(home,'update.lock'),async()=>{
  const next=release||await checkUpdate(home,{force:true});if(!next.available)return{updated:false,message:`Psi ${version} is current.`};
  // Source checkouts retain their branch and refuse to overwrite local changes.
  const origin=await runImpl('git',['remote','get-url','origin'],root).catch(()=>null);
  if(origin){if(!/github\.com[/:]sebastianmiletic\/Psi(?:\.git)?$/.test(origin))throw new Error('Update refused: checkout origin is not the Psi repository.');
   if(!await runImpl('git',['status','--porcelain'],root)){
    await runImpl('git',['fetch','origin','tag','v'+next.latest],root);await runImpl('git',['merge','--ff-only','v'+next.latest],root);await runImpl('npm',['ci','--omit=dev','--ignore-scripts'],root);
    const pkg=await readJSON(join(root,'package.json'),null);if(pkg?.version!==next.latest)throw new Error('Updated checkout version does not match the release.');
    return{updated:true,message:'Updated to '+next.latest+'. Restart Psi.'};
   }
  }
  const statePath=join(home,'installation.json'),previous=await readJSON(statePath,null),installed=previous||{root:join(home,'app')};if(!previous&&!origin)throw new Error('This copy is not a managed installation. Use the GitHub installer or update your source checkout.');
  const asset=next.assets.find(a=>a.name===`psi-v${next.latest}.tar.gz`);if(!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/)||!asset.url.startsWith('https://github.com/'+repository+'/releases/'))throw new Error('The release has no verified source archive.');
  const temp=await mkdtemp(join(tmpdir(),'psi-update-')),destination=join(installed.root,'releases',next.latest);
  await mkdir(join(installed.root,'releases'),{recursive:true});const staging=await mkdtemp(join(installed.root,'releases','.staging-'));
  let published=false;
  try{const archive=join(temp,'psi.tar.gz'),hash=await downloadImpl(asset.url,archive);if('sha256:'+hash!==asset.digest)throw new Error('Release checksum mismatch');
   await runImpl('tar',['-xzf',archive,'-C',staging],temp);const pkg=await readJSON(join(staging,'package.json'),null);if(pkg?.version!==next.latest)throw new Error('Archive version does not match the requested release.');
   await access(join(staging,'bin','psi.mjs'));await runImpl('npm',['ci','--omit=dev','--ignore-scripts'],staging);
   if(await lstat(destination).catch(()=>null))throw new Error('Release destination already exists; active installation was preserved.');
   await rename(staging,destination);published=true;
   const nextState={...installed,current:destination,version:next.latest};
   if(!previous)await activateManaged(home,nextState,{root,launcherTarget});else await atomicJSON(statePath,nextState);
   return{updated:true,message:'Updated to '+next.latest+'. Restart Psi.'+(origin?' Local source changes were preserved in '+root+'.':'')};
  }catch(e){if(published&&(await readJSON(statePath,null))?.current!==destination)await rm(destination,{recursive:true,force:true});throw e;}
  finally{await rm(temp,{recursive:true,force:true});await rm(staging,{recursive:true,force:true});}
 });
}
