import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run,version } from '../src/updates.mjs';
await mkdir('dist',{recursive:true});const name=`psi-v${version}.tar.gz`;
await run('tar',['-czf',join('dist',name),'package.json','package-lock.json','README.md','PRODUCT.md','DESIGN.md','bin','src','scripts','data','assets','docs','examples','test','benchmarks/run_harness_bench.mjs','benchmarks/score_harness_bench.py'],process.cwd());
const sha=createHash('sha256').update(await readFile(join('dist',name))).digest('hex');await writeFile('dist/SHA256SUMS',`${sha}  ${name}\n`);console.log(`dist/${name}`);
