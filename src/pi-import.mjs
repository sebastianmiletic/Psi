import lockfile from 'proper-lockfile';
import { lstat } from 'node:fs/promises';
import { readJSON, atomicJSON } from './storage.mjs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function piTransaction(path,fn){
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Pi account source must be a regular file.');
 const release=await lockfile.lock(path,{realpath:false,stale:30000,retries:{retries:10,minTimeout:100,maxTimeout:1000}});
 try{const data=await readJSON(path,null);return await fn(data,async()=>atomicJSON(path,data));}finally{await release();}
}
export async function sourceCredential(source,fn){
 return piTransaction(source.path,async(data,save)=>{
  const c=data?.providers?.[source.provider]?.accounts?.[source.name];
  if(!c||c.type!=='oauth'||typeof c.access!=='string'||typeof c.refresh!=='string'||!Number.isFinite(c.expires))throw new Error('The linked Pi credential is missing or unsupported. Reimport the account.');
  if(!fn)return structuredClone(c);
  const next=await fn(structuredClone(c));if(next){data.providers[source.provider].accounts[source.name]={...c,...next};await save();}return next||c;
 });
}
export async function importPi(accounts,path,names){
 path=resolve(path);const snapshot=await piTransaction(path,async data=>structuredClone(data));
 const source=snapshot?.providers?.['openai-codex'];if(!source?.accounts)throw new Error('No saved Pi Codex accounts found.');
 if(!names?.length)throw new Error('Choose the Pi account names to import.');
 const selected=names.map(name=>{const c=source.accounts[name];if(!c||c.type!=='oauth'||typeof c.access!=='string'||typeof c.refresh!=='string'||!Number.isFinite(c.expires))throw new Error(`Invalid Pi account: ${name}`);return{name,credential:c};});
 return accounts.mutate(data=>{
  const result=[];for(const {name,credential}of selected){let a=data.accounts.find(a=>a.piSource?.path===path&&a.piSource?.name===name&&a.provider==='openai-codex');
   if(!a){a={id:randomUUID(),provider:'openai-codex',name,createdAt:new Date().toISOString()};data.accounts.push(a);}
   a.credential=structuredClone(credential);a.piSource={path,provider:'openai-codex',name};result.push({id:a.id,name,provider:a.provider,linked:true});if(source.active===name)data.active[a.provider]=a.id;
  }
  data.active['openai-codex'] ||= result[0].id;return result;
 });
}
