import {readdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const buildRoot=fileURLToPath(new URL('..',import.meta.url));
export async function buildIdentity(root=buildRoot){
 const files=['package.json','bin/psi.mjs',...(await readdir(join(root,'src'))).filter(n=>n.endsWith('.mjs')).sort().map(n=>'src/'+n)],hash=createHash('sha256');
 for(const name of files){hash.update(name);hash.update(await readFile(join(root,name)));}
 return hash.digest('hex');
}
export const loadedBuildIdentity=await buildIdentity();
