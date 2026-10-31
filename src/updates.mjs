import { readFile, mkdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
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
 const cache=join(home,'update-check.json'),old=await readJSON(cache,null);
 if(!force&&old&&Date.now()-old.checkedAt<21600000)return old;
 const response=await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'Psi-updater'},signal:AbortSignal.timeout(6000)});
 if(response.status===404)return{checkedAt:Date.now(),latest:version,available:false};if(!response.ok)throw new Error(`GitHub update check: HTTP ${response.status}`);
 const release=await response.json(),latest=release.tag_name?.replace(/^v/,'');
 if(!/^\d+\.\d+\.\d+$/.test(latest))throw new Error('Invalid release version');
 const result={checkedAt:Date.now(),latest,available:newer(latest,version),url:release.html_url,assets:release.assets.map(a=>({name:a.name,url:a.browser_download_url,digest:a.digest}))};await atomicJSON(cache,result);return result;
}
export async function download(url,path,{maxBytes=50000000}={}){
 if(!/^https:\/\/(?:github\.com|release-assets\.githubusercontent\.com)\//.test(url))throw new Error('Untrusted release URL');
 const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw new Error(`Download failed: HTTP ${r.status}`);
 const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>maxBytes)throw new Error('Release archive too large');chunks.push(c);}const bytes=Buffer.concat(chunks);await writeFile(path,bytes,{mode:0o600});return createHash('sha256').update(bytes).digest('hex');
}
export async function updateInstallation(home,{release,root=packageRoot}={}){
 return withLock(join(home,'update.lock'),async()=>{
  const next=release||await checkUpdate(home,{force:true});if(!next.available)return{updated:false,message:`Psi ${version} is current.`};
  // Source checkouts retain their branch and refuse to overwrite local changes.
  const origin=await run('git',['remote','get-url','origin'],root).catch(()=>null);
  if(origin){if(!/github\.com[/:]sebastianmiletic\/Psi(?:\.git)?$/.test(origin))throw new Error('Update refused: checkout origin is not the Psi repository.');
   if(await run('git',['status','--porcelain'],root))throw new Error('Local changes found. Commit or stash them before running psi update.');
   await run('git',['fetch','origin',`tag`,`v${next.latest}`],root);await run('git',['merge','--ff-only',`v${next.latest}`],root);await run('npm',['ci','--omit=dev','--ignore-scripts'],root);
   return{updated:true,message:`Updated to ${next.latest}. Restart Psi.`};
  }
  const statePath=join(home,'installation.json'),installed=await readJSON(statePath,null);if(!installed)throw new Error('This copy is not a managed installation. Use the GitHub installer or update your source checkout.');
  const asset=next.assets.find(a=>a.name===`psi-v${next.latest}.tar.gz`);if(!asset?.digest?.startsWith('sha256:'))throw new Error('The release has no verified source archive.');
  const temp=await mkdtemp(join(tmpdir(),'psi-update-')),destination=join(installed.root,'releases',next.latest);
  try{const archive=join(temp,'psi.tar.gz'),hash=await download(asset.url,archive);if(`sha256:${hash}`!==asset.digest)throw new Error('Release checksum mismatch');
   await mkdir(destination,{recursive:true});await run('tar',['-xzf',archive,'-C',destination],temp);await run('npm',['ci','--omit=dev','--ignore-scripts'],destination);
   await atomicJSON(statePath,{...installed,current:destination,version:next.latest});return{updated:true,message:`Updated to ${next.latest}. Restart Psi.`};
  }finally{await rm(temp,{recursive:true,force:true});}
 });
}
