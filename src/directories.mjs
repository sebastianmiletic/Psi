import { realpath, stat, mkdir, symlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const within=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&r!=='..'&&!isAbsolute(r));};
export async function canonical(path){let p=resolve(path),tail=[];for(;;){try{return resolve(await realpath(p),...tail.reverse());}catch(e){if(e.code!=='ENOENT')throw e;const parent=dirname(p);if(parent===p)throw e;tail.push(basename(p));p=parent;}}}
export class Directories {
  constructor(session,config={}){this.session=session;this.config=config;this.cwd=session.meta.cwd;this.internal=[join(session.dir,'artifacts'),join(session.dir,'agents'),join(session.home,'experiments')];}
  async roots(){return Promise.all((this.session.state.directories||[this.cwd]).map(canonical));}
  async check(path,{internal=true,write=false}={}){
    const p=await canonical(resolve(this.cwd,path)),roots=await this.roots();
    if(internal&&!write&&['plan.json','checkpoint.md','events.jsonl'].some(n=>p===join(this.session.dir,n)))return p;
    if(![...roots,...(internal?await Promise.all(this.internal.map(canonical)):[])].some(root=>within(root,p)))throw new Error(`Directory access denied: ${p}. The user can grant access with /directory <path>.`);
    return p;
  }
  async sandbox(command,cwd,{write=true}={}){
    cwd=await this.check(cwd,{internal:false});
    const roots=await this.roots(),scratch=join(this.session.dir,'scratch');await mkdir(scratch,{recursive:true,mode:0o700});
    const runtime=await canonical(fileURLToPath(new URL('..',import.meta.url)));
    const runtimePaths=['src','bin','scripts','data','node_modules','package.json','package-lock.json'].map(p=>join(runtime,p));
    const read=[...roots,...this.internal,scratch,...runtimePaths];
    const writable=write?[...roots,...this.internal,scratch]:[scratch];
    // Never pass provider credentials or the user's real home into a tool process.
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','LANG','LC_ALL','TERM','COLORTERM','SystemRoot','WINDIR','COMSPEC','PATHEXT','NUMBER_OF_PROCESSORS'].includes(k)));
    Object.assign(env,{HOME:scratch,USERPROFILE:scratch,TMPDIR:scratch,TMPPREFIX:join(scratch,'zsh'),TMP:scratch,TEMP:scratch,WORKSPACE:cwd,PYTHONDONTWRITEBYTECODE:'1'});
    if(process.platform!=='win32'){
      const requested=this.config.python||'python3',python=isAbsolute(requested)?requested:spawnSync('/usr/bin/which',[requested],{encoding:'utf8'}).stdout?.trim();
      if(python){const bin=join(scratch,'bin');await mkdir(bin,{recursive:true});for(const name of ['python','python3'])await symlink(python,join(bin,name)).catch(e=>{if(e.code!=='EEXIST')throw e;});env.PATH=bin+':'+env.PATH;
        const probe=spawnSync(python,['-c','import sys,json;print(json.dumps([sys.prefix,sys.base_prefix]))'],{encoding:'utf8'});if(probe.status===0)read.push(...JSON.parse(probe.stdout));
      }
    }
    if(process.platform==='darwin'){
      const q=s=>JSON.stringify(s),system=['/System','/usr','/bin','/sbin','/Library','/opt/homebrew','/private/etc','/etc','/dev'];
      const profile=`(version 1) (allow default) (deny file-read* file-write*) (allow file-read-metadata) (deny appleevent-send) (deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))\n(allow file-read* (literal "/") ${[...system,...read].map(p=>`(subpath ${q(p)})`).join(' ')})\n(allow file-write* ${writable.map(p=>`(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))`;
      return{argv:['/usr/bin/sandbox-exec','-p',profile,'/bin/zsh','-c',command],env,cwd};
    }
    if(process.platform==='linux'){
      if(spawnSync('bwrap',['--version'],{stdio:'ignore'}).status!==0)throw new Error('Directory isolation requires bubblewrap. Install it with your OS package manager; shell tools stay disabled until it is available.');
      const argv=['bwrap','--die-with-parent','--new-session','--unshare-user','--unshare-pid','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
      for(const p of ['/usr','/bin','/sbin','/lib','/lib64','/etc'])if(await stat(p).catch(()=>null))argv.push('--ro-bind',p,p);
      for(const p of [...new Set(read)]){await mkdir(p,{recursive:true}).catch(()=>{});argv.push('--ro-bind',p,p);}
      for(const p of [...new Set(writable)])argv.push('--bind',p,p);
      argv.push('--chdir',cwd,'/bin/sh','-c',command);return{argv,env,cwd};
    }
    throw new Error('Shell directory isolation on Windows requires running Psi inside WSL2 with bubblewrap. File/research tools remain available in native Windows. No unrestricted shell fallback is used.');
  }
}
