import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Jobs} from '../src/jobs.mjs';
test('fast commands keep output and terminal receipts instead of exiting before the close listener',{skip:process.platform==='win32'},async t=>{
 const home=await mkdtemp(join(tmpdir(),'psi-fast-jobs-'));t.after(()=>rm(home,{recursive:true,force:true}));const jobs=new Jobs(home,'fast');
 const started=await Promise.all(Array.from({length:12},(_,i)=>jobs.start("printf 'receipt-"+i+"'",home)));
 const done=await Promise.all(started.map(j=>jobs.awaitCompletion(j.id)));for(const [i,row]of done.entries()){assert.equal(row.status,'completed',JSON.stringify(row));assert.equal(row.exitCode,0);assert.equal(await jobs.tail(row.id),'receipt-'+i);}
});
