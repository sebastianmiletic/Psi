import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Battlecode } from '../src/battlecode.mjs';
import { battlecodeFixture } from './battlecode-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('project adapter runs the existing controller/collector and qualifies only after fresh replay-backed confirmation',async t=>{
  const f=await battlecodeFixture(t);const p=await f.adapter.inspect();assert.equal(p.baselineVersion,248);
  let e=await f.create();await f.freeze(e);await f.check(e);
  await assert.rejects(f.adapter.trial(e.id,'confirmation'),/Discovery/);
  e=await f.panel(e,'discovery');assert.equal(e.discoveryDecision.gains,1);assert.equal(e.phase,'discovery_passed');
  const reused=await f.adapter.trial(e.id,'discovery');assert.equal(reused.reused,true);
  e=await f.panel(e,'confirmation');assert.equal(e.phase,'qualified_for_review');assert.equal(e.confirmationDecision.games,5);
  assert.equal(e.confirmationDecision.version,e.discoveryDecision.version);assert.equal(e.confirmationDecision.broadSuperiorityProven,false);
  const queues=await readFile(join(f.root,'queue-count.txt'),'utf8');assert.equal((queues.match(/discovery|confirmation/g)||[]).length,2);
  assert.deepEqual((await f.adapter.inspect()).baselineHashes,p.baselineHashes);
  const recovered=new Battlecode({session:f.session,jobs:f.jobs,config:f.config,home:f.home});assert.equal((await recovered.reconcile(e.id)).phase,'qualified_for_review');
});
test('confirmation fixtures must be fresh and candidates must remain separate from the incumbent',async t=>{
  const f=await battlecodeFixture(t);
  await assert.rejects(f.adapter.create({hypothesis:'test',discovery_control:'controls/discovery',confirmation_controls:['controls/discovery']}),/fresh/);
  await assert.rejects(f.adapter.create({hypothesis:'test',discovery_control:'controls/discovery',confirmation_controls:['controls/confirmation'],candidate:'bots/vision-v6'}),/separate/);
});
test('decision verifies actual archived stdout, not a forged marker_verified boolean',async t=>{
  const f=await battlecodeFixture(t);let e=await f.create();await f.freeze(e);await f.check(e);await writeFile(join(f.root,'scenario.json'),JSON.stringify({omit_marker:true}));
  await f.awaitOperation(await f.adapter.trial(e.id,'discovery'));await f.awaitOperation(await f.adapter.collect(e.id,'discovery'));
  await assert.rejects(f.adapter.decide(e.id,'discovery'),/actual stdout marker/);
  assert.notEqual((await f.adapter.store.get(e.id)).phase,'qualified_for_review');
});
test('a recovered loss with any incumbent win regression is rejected',async t=>{
  const f=await battlecodeFixture(t);let e=await f.create();await f.freeze(e);await f.check(e);await writeFile(join(f.root,'scenario.json'),JSON.stringify({regression:true}));
  e=await f.panel(e,'discovery');assert.equal(e.discoveryDecision.gains,1);assert.equal(e.discoveryDecision.regressions,1);assert.equal(e.phase,'rejected');
  await assert.rejects(f.adapter.trial(e.id,'confirmation'),/Discovery/);
});
test('changed frozen source is refused before a live operation can be started',async t=>{
  const f=await battlecodeFixture(t);const e=await f.create();await f.freeze(e);await f.check(e);
  await appendFile(join(e.candidate,'src/main.cpp'),'\n// changed');
  await assert.rejects(f.adapter.trial(e.id,'discovery'),/source.*mismatch/i);
  await assert.rejects(readFile(join(f.root,'queue-count.txt')));
});
test('an ambiguous persisted live launch cannot be replayed after a process restart',async t=>{
  const f=await battlecodeFixture(t);const e=await f.create();await f.freeze(e);await f.check(e);
  await f.adapter.store.update(e.id,'simulated_crash',d=>{d.operations['trial-discovery-0']={kind:'trial',operationId:'unknown',label:'lost-job',status:'launching',stage:'discovery',out:join(f.home,'unknown-trial')};});
  const recovered=await f.adapter.reconcile(e.id);assert.equal(recovered.phase,'needs_reconciliation');
  const result=await f.adapter.trial(e.id,'discovery');assert.equal(result.reused,true);assert.equal(result.operation.status,'needs_reconciliation');
  await assert.rejects(f.adapter.recoverTrial(e.id,'discovery'),/Incomplete/);
  await assert.rejects(readFile(join(f.root,'queue-count.txt')));
});

test('fresh baseline controls use the existing controller and become immutable preselected controls',async t=>{
  const f=await battlecodeFixture(t),maps=['fresh-0','fresh-1','fresh-2','fresh-3','fresh-4'];
  const launched=await f.adapter.baselineControl({source_group:'discovery-control',maps});
  let e=await f.awaitOperation(launched);assert.equal(e.kind,'baseline_control');
  e=await f.awaitOperation(await f.adapter.collect(e.id,'discovery'));
  const control=await f.adapter.control(e.operations['trial-discovery-0'].out,248,'our-team');
  assert.deepEqual(control.fixture.maps,maps);assert.equal(control.keys.length,5);
  assert.equal((await f.adapter.inspect()).baselineVersion,248);
  await assert.rejects(readFile(join(e.candidate,'experiment.json')));
});

test('evidence edits after collection invalidate a decision',async t=>{
  const f=await battlecodeFixture(t);let e=await f.create();await f.freeze(e);await f.check(e);
  await f.awaitOperation(await f.adapter.trial(e.id,'discovery'));e=await f.awaitOperation(await f.adapter.collect(e.id,'discovery'));
  const path=join(e.operations['trial-discovery-0'].out,'results.json'),rows=JSON.parse(await readFile(path));rows[0].actions.fuel=1;await writeFile(path,JSON.stringify(rows));
  await assert.rejects(f.adapter.decide(e.id,'discovery'),/evidence changed/);
});

test('stopping a live worker allows controller cleanup beyond the ordinary two-second kill window',{timeout:12000},async t=>{
  const f=await battlecodeFixture(t),e=await f.create();await f.freeze(e);await f.check(e);
  await writeFile(join(f.root,'scenario.json'),JSON.stringify({cancel_delay:true}));
  const launched=await f.adapter.trial(e.id,'discovery'),id=launched.operation.jobId;
  t.after(()=>f.jobs.stop(id).catch(()=>{}));
  let ready=false;for(let i=0;i<150;i++){ready=await readFile(join(f.root,'controller-ready.txt')).then(()=>true,()=>false);if(ready)break;await delay(20);}
  assert.equal(ready,true);await f.jobs.stop(id);await f.jobs.awaitCompletion(id);
  assert.equal(await readFile(join(f.root,'cleanup-finished.txt'),'utf8'),'incumbent restored');
  assert.equal((await f.adapter.reconcile(e.id)).phase,'needs_reconciliation');
});
