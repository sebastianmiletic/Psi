import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Session} from '../src/session.mjs';
import {withLock} from '../src/storage.mjs';
import {fixture} from './helpers.mjs';

async function home(t){const dir=await mkdtemp(join(tmpdir(),'psi-drafts-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('empty sessions stay out of history even after settings or an explicit name; close removes them',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));assert.deepEqual(await Session.list(f.app.home),[]);await f.app.update({accent:'cyan'});await f.session.rename('Named but empty');assert.deepEqual(await Session.list(f.app.home),[]);
 await f.app.close();assert.equal(await stat(f.session.dir).catch(()=>null),null);
});

test('the first message saves an automatically titled session; closing preserves its conversation',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));await f.session.message({role:'user',content:'Build a replay explorer',timestamp:Date.now()});let list=await Session.list(f.app.home);assert.equal(list.length,1);assert.equal(list[0].title,'Build a replay explorer');assert.equal(list[0].draft,false);
 await f.app.close();const saved=await Session.load(f.session.meta.id,f.app.home);assert.equal(saved.messages[0].content,'Build a replay explorer');assert.equal((await Session.list(f.app.home)).length,1);
});

test('/new removes the previous empty draft without touching an existing conversation',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));const old=f.session.dir;await f.app.submit('/new');assert.equal(await stat(old).catch(()=>null),null);assert.deepEqual(await Session.list(f.app.home),[]);
 await f.app.session.message({role:'user',content:'Keep this conversation',timestamp:Date.now()});const saved=f.app.session.meta.id;await f.app.submit('/new');assert.deepEqual((await Session.list(f.app.home)).map(s=>s.id),[saved]);
});

test('empty cleanup checks the durable journal and lock rather than deleting another writer’s message',async t=>{
 const dir=await home(t),first=await Session.create(dir,dir),other=await Session.load(first.meta.id,dir);
 await withLock(join(first.dir,'run.lock'),async()=>assert.equal(await first.discardEmpty(),false));await other.message({role:'user',content:'Committed by another process',timestamp:Date.now()});assert.equal(await first.discardEmpty(),false);assert.equal((await Session.load(first.meta.id,dir)).messages.length,1);
});

test('legacy empty snapshots are hidden while legacy titled conversations remain discoverable',async t=>{
 const dir=await home(t),empty=await Session.create(dir,dir),saved=await Session.create(dir,dir);
 const meta={...saved.meta,title:'Legacy conversation'};delete meta.hasMessages;delete meta.draft;await writeFile(join(saved.dir,'meta.json'),JSON.stringify(meta));await saved.event({type:'message',message:{role:'user',content:'Existing conversation',timestamp:1}});
 assert.deepEqual((await Session.list(dir)).map(s=>s.id),[saved.meta.id]);assert.equal(await empty.discardEmpty(),true);assert.equal(await saved.discardEmpty(),false);
});
