#!/usr/bin/env node
// Standalone, dependency-free installer for macOS, Linux and Windows.
import { mkdir, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<19))throw new Error('Install Node.js 22.19 or newer first: https://nodejs.org');
const home=process.env.PSI_HOME||join(homedir(),'.psi'),root=join(home,'app'),bin=process.platform==='win32'?join(home,'bin'):join(homedir(),'.local','bin');
const response=await fetch('https://api.github.com/repos/sebastianmiletic/Psi/releases/latest',{headers:{'User-Agent':'Psi-installer'}});if(!response.ok)throw new Error(`GitHub release unavailable: HTTP ${response.status}`);
const release=await response.json(),version=release.tag_name.replace(/^v/,'');if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid release version');
const asset=release.assets.find(a=>a.name===`psi-v${version}.tar.gz`);if(!asset?.digest?.startsWith('sha256:')||!asset.browser_download_url.startsWith('https://github.com/sebastianmiletic/Psi/releases/'))throw new Error('Verified archive unavailable');
const temp=await mkdtemp(join(tmpdir(),'psi-install-')),destination=join(root,'releases',version);
function run(exe,args){const r=process.platform==='win32'&&exe==='npm'?spawnSync(process.env.COMSPEC||'cmd.exe',['/d','/s','/c','npm '+args.join(' ')],{cwd:destination,stdio:'inherit'}):spawnSync(exe,args,{cwd:destination,stdio:'inherit'});if(r.status!==0)throw new Error(`${exe} failed; the active installation was not changed.`);}
try{
 const r=await fetch(asset.browser_download_url);if(!r.ok)throw new Error('Archive download failed');const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>50000000||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==asset.digest)throw new Error('Archive checksum mismatch');
 const archive=join(temp,'psi.tar.gz');await writeFile(archive,bytes);await mkdir(destination,{recursive:true});run('tar',['-xzf',archive,'-C',destination]);run('npm',['ci','--omit=dev','--ignore-scripts']);
 await mkdir(bin,{recursive:true});const state=join(home,'installation.json'),launcher=join(root,'launcher.cjs');
 await writeFile(launcher,`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),url=require('node:url');const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));import(url.pathToFileURL(path.join(s.current,'bin','psi.mjs')).href);\n`,{mode:0o755});
 const target=join(bin,process.platform==='win32'?'psi.cmd':'psi');
 // An existing source-checkout launcher is left intact; use its own update path.
 if(await import('node:fs/promises').then(fs=>fs.lstat(target).catch(()=>null)))throw new Error(`${target} already exists. Remove it only if you want to replace that installation.`);
 if(process.platform==='win32')await writeFile(target,`@echo off\r\nnode "${launcher}" %*\r\n`);else await writeFile(target,`#!/bin/sh\nexec node '${launcher.replaceAll("'","'\\''")}' "$@"\n`,{mode:0o755});
 const staged=state+'.tmp';await writeFile(staged,JSON.stringify({root,current:destination,version})+'\n',{mode:0o600});await rename(staged,state);
 console.log(`Installed Psi ${version}. Add ${bin} to PATH, then run psi.`);
 if(process.platform==='win32')console.log('For isolated shell tools, install/run Psi inside WSL2 with bubblewrap. Native Windows supports file/research tools.');
}finally{await rm(temp,{recursive:true,force:true});}
