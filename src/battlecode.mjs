import { readFile, readdir, stat, lstat, mkdir, cp, writeFile, symlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import { readJSON, atomicJSON, withLock } from './storage.mjs';
import { capture } from './tools.mjs';
import { Experiments } from './experiments.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
const exists=path=>stat(path).then(()=>true,()=>false);
const inside=(base,path)=>{const r=relative(base,path);return !r.startsWith('..')&&!isAbsolute(r);};
export const shellCommand=argv=>argv.map(s=>"'"+String(s).replaceAll("'","'\"'\"'")+"'").join(' ');
export async function fileHash(path) { const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex'); }
export async function sourceHashes(path) {
  const files={};
  async function walk(dir) { for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const p=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Source symlinks are not allowed in a frozen candidate');
    if(entry.isDirectory())await walk(p);else if(entry.isFile())files[relative(path,p)]=await fileHash(p);
  } }
  await walk(path);return {files,fingerprint:sha(JSON.stringify(files))};
}
function same(a,b,label) {if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${label} mismatch`);}
const sideNumber=side=>side==='a'||side===0?0:side==='b'||side===1?1:null;
export class Battlecode {
  constructor({session,jobs,config,home}) {this.session=session;this.root=session.meta.cwd;this.jobs=jobs;this.config=config;this.home=home||session.home;this.store=new Experiments(this.home);}
  async inspect() {
    const readme=await readFile(join(this.root,'README.md'),'utf8').catch(()=> '');
    const version=Number(readme.match(/VisionV\d+\s+(?:platform\s+)?v(\d+)/i)?.[1]);
    const bot=readme.match(/bots\/vision-v\d+(?=[/`\s;])/i)?.[0];
    if(!version||!bot)throw new Error('No documented Vision baseline found in this project README');
    const baseline=resolve(this.root,bot),manifest=await readJSON(join(baseline,'manifest.json'),null);
    if(!manifest||manifest.platform_version!==version)throw new Error('README and frozen baseline manifest disagree');
    const hashes=await sourceHashes(join(baseline,'src'));
    if(manifest.files)for(const [path,hash] of Object.entries(manifest.files))if(hashes.files[path]!==hash)throw new Error(`Frozen baseline source changed: ${path}`);
    const scripts={};for(const [key,name]of Object.entries({trial:'live_trial.py',collect:'live_collect.py',report:'live_report.py',audit:'live_ranked_audit.py',observation:'check_observation.py'})) {
      const path=join(this.root,'tools/vision',name);if(await exists(path))scripts[key]=path;
    }
    for(const key of ['trial','collect','report'])if(!scripts[key])throw new Error(`Project controller missing: ${key}`);
    const controller=await readFile(scripts.trial,'utf8');const teamId=controller.match(/\bOUR\s*=\s*['"]([^'"]+)/)?.[1];if(!teamId)throw new Error('Cannot determine own team from the project controller');
    if(manifest.files) same(Object.keys(hashes.files).sort(),Object.keys(manifest.files).sort(),'Baseline file set');
    const cli=this.config.battlecodeCli||join(homedir(),'.venvs/cambc400/bin/cambc');
    return {project:this.root,teamId,baseline,baselineVersion:version,baselineHashes:hashes,cli,scripts,
      policy:'Local runs are correctness evidence; compare complete identity-checked live fixture groups and confirm on preselected fresh fixtures. Live trials upload/select only within a requested live objective; no automatic release.'};
  }
  async control(path,baselineVersion,teamId) {
    path=resolve(this.root,path);const receipt=await readJSON(join(path,'receipt.json'),null),rows=await readJSON(join(path,'results.json'),null);
    if(!receipt?.group_id||receipt.version!==baselineVersion||!Array.isArray(rows)||rows.length!==5)throw new Error('A control needs a complete five-game baseline receipt and results');
    const {maps,sides,opponent}=receipt.fixture||{};
    const group=await readJSON(join(path,'group.json'),null);
    if(!group?.matches||group.matches.length!==5||group.matches.some(m=>m.status!=='finished'))throw new Error('Control group metadata must contain all five finished games');
    if(maps?.length!==5||sides?.length!==5||new Set(maps).size!==5||!opponent||sides.some(s=>sideNumber(s)===null))throw new Error('Control fixture is incomplete');
    if(new Set(rows.map(r=>`${r.map_id}:${r.side}`)).size!==5)throw new Error('Control results have duplicate fixtures');
    for(let i=0;i<5;i++)if(!rows.some(r=>r.map_id===maps[i]&&r.side===sideNumber(sides[i])))throw new Error('Control result does not match its fixture');
    const files={};for(const name of ['receipt.json','results.json','group.json'])if(await exists(join(path,name)))files[name]=await fileHash(join(path,name));
    for(const row of rows) {
      const match=group.matches.find(m=>m.matchId===row.match&&m.mapId===row.map_id);const own=match?.teams?.find(t=>t.teamId===teamId),other=match?.teams?.find(t=>t.teamId!==teamId);
      if(!own||!other||other.teamId!==opponent||sideNumber(own.side)!==row.side||own.result!==(row.win?'win':'loss'))throw new Error('Control metadata, opponent or outcome mismatch');
      if(!/^[a-f\d]{64}$/.test(row.replay_sha256||''))throw new Error('Control replay hash missing');
      const replay=join(path,'replays',`${row.match}.repl26a`);
      if(await fileHash(replay)!==row.replay_sha256)throw new Error('Control replay hash mismatch');
      files[`replays/${row.match}.repl26a`]=row.replay_sha256;
    }
    const engines=[...new Set(group.matches.flatMap(m=>m.teams.map(t=>t.engineVersion)))];if(engines.length!==1||typeof engines[0]!=='string')throw new Error('Control engine identities are inconsistent');
    return {path,engine:engines[0],groupId:receipt.group_id,fixture:receipt.fixture,files,keys:maps.map((map,i)=>`${opponent}:${map}:${sideNumber(sides[i])}`)};
  }
  async unchangedControl(control) {for(const [p,h] of Object.entries(control.files))if(await fileHash(join(control.path,p))!==h)throw new Error('A preselected control changed after experiment creation');}
  async create({hypothesis,discovery_control,confirmation_controls,candidate}) {
    if(!hypothesis?.trim())throw new Error('A concrete hypothesis is required');
    const project=await this.inspect();
    const discovery=await this.control(discovery_control,project.baselineVersion,project.teamId);
    const confirmation=await Promise.all((confirmation_controls||[]).map(path=>this.control(path,project.baselineVersion,project.teamId)));
    if(!confirmation.length)throw new Error('Preselect at least one fresh confirmation control before discovery');
    const seen=new Set(discovery.keys);
    for(const c of confirmation)for(const key of c.keys){if(seen.has(key))throw new Error('Confirmation must use fresh opponent/map/side fixtures, without duplicates');seen.add(key);}
    if(candidate) {candidate=resolve(this.root,candidate);if(inside(project.baseline,candidate)||inside(candidate,project.baseline))throw new Error('Candidate must be separate from the incumbent');await sourceHashes(join(candidate,'src'));if(await exists(join(candidate,'experiment.json')))throw new Error('Candidate already belongs to an experiment; use a new isolated copy');}
    let exp=await this.store.create({project:this.root,baseline:project.baseline,baselineVersion:project.baselineVersion,baselineHashes:project.baselineHashes,hypothesis,
      controls:{discovery,confirmation},marker:`PSI_${randomUUID().replaceAll('-','')}`,candidate:candidate||null});
    if(!candidate) {
      const target=join(this.store.path(exp.id),'candidate');await mkdir(target,{recursive:true});await cp(join(project.baseline,'src'),join(target,'src'),{recursive:true});
      exp=await this.store.update(exp.id,'candidate_copied',d=>{d.candidate=target;});
    }
    await atomicJSON(join(exp.candidate,'experiment.json'),{identity_marker:exp.marker,mechanism:hypothesis,psi_experiment:exp.id});
    return exp;
  }
  async verifyBaseline(exp) {const current=await this.inspect();same(current.baselineHashes,exp.baselineHashes,'Baseline');same(current.baselineVersion,exp.baselineVersion,'Baseline version');return current;}
  async freeze(id) {
    const exp=await this.store.get(id);await this.verifyBaseline(exp);
    if(Object.values(exp.operations).some(op=>op.kind==='trial'))throw new Error('A tested candidate is immutable; create another experiment');
    const source=await sourceHashes(join(exp.candidate,'src'));let marker=false;
    for(const p of Object.keys(source.files))if((await readFile(join(exp.candidate,'src',p),'utf8')).includes(exp.marker))marker=true;
    if(!marker)throw new Error(`Add the identity marker to actual candidate source before freezing: ${exp.marker}`);
    return this.store.update(id,'source_frozen',d=>{d.source=source;d.phase='frozen';d.correctness=null;});
  }
  async verifyCandidate(exp) {if(!exp.source)throw new Error('Freeze the candidate first');same(await sourceHashes(join(exp.candidate,'src')),exp.source,'Candidate source');await this.verifyBaseline(exp);}
  async startOperation(id,key,kind,spec) {
    return withLock(join(this.store.path(id),'launch.lock'),async()=>{
      let exp=await this.store.get(id);let op=exp.operations[key];
      if(op)return {experiment:exp,operation:op,reused:true};
      const operationId=randomUUID(),label=`psi-experiment:${id}:${operationId}`;
      exp=await this.store.update(id,'operation_intent',d=>{d.operations[key]={key,kind,operationId,label,status:'launching',...spec};d.phase=kind==='trial'?`${spec.stage}_running`:kind==='collect'?`${spec.stage}_collecting`:`${kind}_running`;});
      const job=await this.jobs.start(shellCommand([process.execPath,fileURLToPath(new URL('./battlecode-worker.mjs',import.meta.url)),join(this.store.path(id),'experiment.json'),key]),this.root,{label,graceful_stop_ms:['trial','control'].includes(kind)?360000:5000});
      exp=await this.store.update(id,'operation_started',d=>{d.operations[key].jobId=job.id;d.operations[key].status='running';});
      return {experiment:exp,operation:exp.operations[key]};
    });
  }
  async correctness(id) {
    const exp=await this.store.get(id);await this.verifyCandidate(exp);const p=await this.inspect();
    const checks=this.config.battlecodeChecks || (p.scripts.observation?[[this.config.python||'python3','-I',p.scripts.observation]]:[]);
    if(!checks.length)throw new Error('Configure a correctness check command for this project');
    const key=`correctness-${exp.source.fingerprint.slice(0,12)}`;
    return this.startOperation(id,key,'correctness',{commands:[[p.cli,'build',exp.candidate,'--release'],...checks],source:exp.source.fingerprint,phase:'correctness'});
  }
  async trial(id,stage,index=0) {
    let exp=await this.reconcile(id);await this.verifyCandidate(exp);
    if(!exp.correctness?.passed)throw new Error('Complete correctness checks before a live trial');
    const wasm=join(exp.candidate,'.cambc/build-release/bot-injected.wasm');
    if(await fileHash(wasm)!==exp.correctness.wasmHash)throw new Error('The tested artifact changed after correctness checks');
    if(!['discovery','confirmation'].includes(stage))throw new Error('Stage must be discovery or confirmation');
    if(stage==='confirmation'&&!exp.discoveryDecision?.passed)throw new Error('Discovery needs a verified gain with no lost incumbent wins');
    const control=stage==='discovery'?exp.controls.discovery:exp.controls.confirmation[index];if(!control)throw new Error('Confirmation control index is invalid');
    await this.unchangedControl(control);
    const p=await this.inspect(),key=`trial-${stage}-${index}`,out=join(this.store.path(id),'trials',key);
    const identity=stage==='confirmation'?['--version',String(exp.discoveryDecision.version),'--marker',exp.marker]:['--candidate',exp.candidate,'--note',`${exp.id}: ${exp.hypothesis}`];
    const commands=[[this.config.python||'python3',p.scripts.trial,'--baseline',String(exp.baselineVersion),'--source-group',control.groupId,...identity,'--out',out]];
    return this.startOperation(id,key,'trial',{commands,out,stage,index,control,source:exp.source.fingerprint});
  }
  async collect(id,stage,index=0) {
    const exp=await this.reconcile(id),trial=exp.operations[`trial-${stage}-${index}`];
    if(!trial?.out||!['completed','reconciled'].includes(trial.status))throw new Error('Reconcile and finish the live transaction before collection');
    const receipt=await readJSON(join(trial.out,'receipt.json'),null);
    if(!receipt?.group_id)throw new Error('Trial has no confirmed match-group receipt; never recreate it blindly');
    const p=await this.inspect(),key=`collect-${stage}-${index}`;
    const previous=exp.operations[key];
    if(previous?.status==='failed')return this.store.update(id,'collection_retry_available',d=>{(d.operationHistory ||= []).push(d.operations[key]);delete d.operations[key];}).then(()=>this.collect(id,stage,index));
    return this.startOperation(id,key,'collect',{commands:[[this.config.python||'python3',p.scripts.collect,trial.out]],stage,index,out:trial.out,source:exp.source.fingerprint});
  }
  async reconcile(id) {
    let exp=await this.store.get(id);if(exp.project!==this.root)throw new Error('Open the experiment in its recorded workspace');
    for(const [key,op]of Object.entries(exp.operations)) {
      if(['completed','failed','cancelled','reconciled'].includes(op.status))continue;
      let job=op.jobId?await this.jobs.get(op.jobId).catch(()=>null):null;
      if(!job)job=(await this.jobs.list()).find(j=>j.label===op.label);
      const result=await readJSON(join(this.store.path(id),`${op.operationId}.result.json`),null);
      exp=await this.store.update(id,'operation_reconciled',d=>{
        const current=d.operations[key];if(job)current.jobId=job.id;
        if(result) {current.status=result.ok?'completed':'failed';current.result=result;
          if(op.kind==='correctness'&&result.ok){d.correctness={passed:true,source:op.source,wasmHash:result.wasmHash,operation:key};d.phase='correctness_passed';}
          else if(result.ok&&op.kind==='collect')d.phase=`${op.stage}_collected`;
          else if(!result.ok)d.phase=op.kind==='trial'?'needs_reconciliation':`${op.kind}_failed`;
        } else if(job&&['running','queued'].includes(job.status))current.status='running';
        else {current.status='needs_reconciliation';d.phase='needs_reconciliation';}
      });
    }
    return exp;
  }
  async recoverTrial(id,stage,index=0) {
    const exp=await this.reconcile(id),key=`trial-${stage}-${index}`,op=exp.operations[key];
    if(!op)throw new Error('No trial to recover');
    if(op.status==='running')throw new Error('Live controller is still running; wait for restoration');
    const receipt=await readJSON(join(op.out,'receipt.json'),null),settled=await readJSON(join(op.out,'settled-state.json'),null);
    if(!receipt?.group_id||receipt.baseline!==exp.baselineVersion||!receipt.baseline_selected_after||!receipt.baseline_active_after||!settled||settled.active?.version!==exp.baselineVersion||settled.selected?.version!==exp.baselineVersion)throw new Error('Incomplete restoration/queue receipts: reconcile the existing controller and platform state before continuing');
    return this.store.update(id,'trial_receipt_recovered',d=>{d.operations[key].status='reconciled';d.phase='trial_reconciled';});
  }
  async verifyPanel(exp,stage,index) {
    await this.verifyCandidate(exp);const project=await this.inspect();
    const op=exp.operations[`trial-${stage}-${index}`],control=stage==='discovery'?exp.controls.discovery:exp.controls.confirmation[index];
    if(!op?.out)throw new Error('Missing trial');await this.unchangedControl(control);
    const collected=exp.operations[`collect-${stage}-${index}`];
    if(collected?.status!=='completed'||!collected.result?.evidence)throw new Error('Complete durable replay collection before deciding');
    for(const [name,hash]of Object.entries(collected.result.evidence))if(await fileHash(join(op.out,name))!==hash)throw new Error('Collected replay evidence changed after collection');
    const receipt=await readJSON(join(op.out,'receipt.json'),null),rows=await readJSON(join(op.out,'results.json'),null),group=await readJSON(join(op.out,'group.json'),null);
    const settled=await readJSON(join(op.out,'settled-state.json'),null);
    if(!settled||settled.active?.version!==exp.baselineVersion||settled.selected?.version!==exp.baselineVersion||settled.pinned!==true)throw new Error('Final incumbent state readback is missing or inconsistent');
    if(receipt?.version===exp.baselineVersion || (stage==='confirmation'&&receipt?.version!==exp.discoveryDecision?.version))throw new Error('Candidate version changed between discovery and confirmation');
    if(!receipt||receipt.baseline!==exp.baselineVersion||receipt.source_group!==control.groupId||!receipt.baseline_active_after||!receipt.baseline_selected_after||!receipt.jobs_finished_and_baseline_active)throw new Error('Trial restoration or identity receipts incomplete');
    same(receipt.fixture.maps,control.fixture.maps,'Map');same(receipt.fixture.sides,control.fixture.sides,'Side');same(receipt.fixture.opponent,control.fixture.opponent,'Opponent');
    if(!rows||rows.length!==5||!group?.matches||group.matches.length!==5||group.matches.some(m=>m.status!=='finished'))throw new Error('All five games and replays must finish');
    const before=await readJSON(join(control.path,'results.json'),null),keys=new Set(),matches=new Set();let gains=0,regressions=0;
    for(const row of rows) {
      const key=`${row.map_id}:${row.side}`;if(keys.has(key)||matches.has(row.match))throw new Error('Duplicate replay or fixture');keys.add(key);matches.add(row.match);
      const reference=before.find(r=>r.map_id===row.map_id&&r.side===row.side);if(!reference)throw new Error('Replay does not match a control fixture');
      if(typeof row.win!=='boolean'||typeof reference.win!=='boolean')throw new Error('Missing outcome');
      const original=group.matches.find(m=>m.matchId===row.match&&m.mapId===row.map_id);if(!original)throw new Error('Replay is absent from recorded group');
      if(original.teams?.some(t=>t.engineVersion!==control.engine))throw new Error('Engine version changed from the control');
      const own=original.teams?.find(t=>t.teamId===project.teamId),other=original.teams?.find(t=>t.teamId!==project.teamId);
      if(!own||!other||other.teamId!==control.fixture.opponent||sideNumber(own.side)!==row.side||own.result!==(row.win?'win':'loss'))throw new Error('Replay side, opponent or outcome is inconsistent with the actual group');
      if(!row.marker_verified||row.marker!==exp.marker)throw new Error('Candidate marker missing');
      if(!Array.isArray(row.logged_errors)||!Number.isFinite(row.actions?.error)||!Number.isFinite(row.actions?.fuel)||row.logged_errors.length||row.actions.error>0||row.actions.fuel>0)throw new Error('Candidate runtime fault or fuel exhaustion');
      const replay=join(op.out,'replays',`${row.match}.repl26a`);
      const check=await capture(this.config.python||'python3',[fileURLToPath(new URL('./battlecode-evidence.py',import.meta.url)),replay,String(row.side),exp.marker],this.root);
      if(check.code!==0)throw new Error(`Replay archive cannot be verified: ${row.match}`);
      const verified=JSON.parse(check.text);if(verified.sha256!==row.replay_sha256||!verified.marker_verified)throw new Error('Replay bytes or actual stdout marker mismatch');
      if(row.win&&!reference.win)gains++;if(reference.win&&!row.win)regressions++;
    }
    return {stage,index,version:receipt.version,groupId:receipt.group_id,sourceGroup:control.groupId,games:5,gains,regressions,passed:regressions===0&&gains>0,
      candidateHash:exp.source.fingerprint,replayHashes:rows.map(r=>r.replay_sha256),evidence:'exact paired live fixtures',broadSuperiorityProven:false};
  }
  async decide(id,stage) {
    const exp=await this.reconcile(id);if(!['discovery','confirmation'].includes(stage))throw new Error('Invalid stage');
    if(stage==='confirmation'&&!exp.discoveryDecision?.passed)throw new Error('Discovery has not passed');
    const panels=[];for(let i=0;i<(stage==='discovery'?1:exp.controls.confirmation.length);i++)panels.push(await this.verifyPanel(exp,stage,i));
    // Confirmation preserves every incumbent win, with at least one gain across the complete fresh set.
    const decision={stage,version:panels[0].version,panels,games:panels.length*5,gains:panels.reduce((n,p)=>n+p.gains,0),regressions:panels.reduce((n,p)=>n+p.regressions,0),broadSuperiorityProven:false};
    decision.passed=decision.regressions===0&&decision.gains>0;
    return this.store.update(id,`${stage}_decision`,d=>{d[`${stage}Decision`]=decision;d.phase=decision.passed?(stage==='discovery'?'discovery_passed':'qualified_for_review'):'rejected';});
  }
  async baselineControl({source_group,maps}) {
    if(!source_group||!Array.isArray(maps)||maps.length!==5||new Set(maps).size!==5)throw new Error('Supply a historical source group and five distinct fresh map UUIDs');
    const p=await this.inspect();const e=await this.store.create({kind:'baseline_control',project:this.root,baseline:p.baseline,baselineVersion:p.baselineVersion,baselineHashes:p.baselineHashes,candidate:p.baseline,source:p.baselineHashes});
    const out=join(this.store.path(e.id),'trials','baseline-control');
    return this.startOperation(e.id,'trial-discovery-0','control',{commands:[[this.config.python||'python3',p.scripts.trial,'--baseline',String(p.baselineVersion),'--version',String(p.baselineVersion),'--source-group',source_group,'--baseline-maps',maps.join(','),'--out',out]],out,stage:'discovery',source:p.baselineHashes.fingerprint});
  }
  async validateQualification(id){const discovery=await this.decide(id,'discovery');if(!discovery.discoveryDecision.passed)throw new Error('Discovery no longer passes');const result=await this.decide(id,'confirmation');if(result.phase!=='qualified_for_review')throw new Error('Confirmation no longer passes');return result;}
  view(d){return{id:d.id,kind:d.kind||'experiment',phase:d.phase,hypothesis:d.hypothesis,candidate:d.candidate,marker:d.marker,baselineVersion:d.baselineVersion,sourceFingerprint:d.source?.fingerprint,manifest:join(this.store.path(d.id),'experiment.json'),discoveryDecision:d.discoveryDecision,confirmationDecision:d.confirmationDecision,operations:Object.fromEntries(Object.entries(d.operations).map(([k,o])=>[k,{kind:o.kind,status:o.status,jobId:o.jobId,out:o.out,result:o.result}]))};}
  operationView(r){return{experiment:this.view(r.experiment),operation:r.operation,reused:!!r.reused};}
  async report(id) {
    const exp=await this.reconcile(id),project=await this.inspect(),root=join(this.store.path(id),'trials');await mkdir(root,{recursive:true});
    for(const c of [exp.controls.discovery,...exp.controls.confirmation]){await this.unchangedControl(c);const target=join(root,'control-'+sha(c.groupId).slice(0,12));if(!await exists(target))await symlink(c.path,target,'dir');}
    return this.startOperation(id,`report-${Object.keys(exp.operations).length}`,'report',{commands:[[this.config.python||'python3',project.scripts.report,'--root',root,'--baseline',String(exp.baselineVersion)]],source:exp.source?.fingerprint,out:join(root,'live-comparison.json')});
  }
  register(tools) {
    const str=Type.String(),opt=x=>Type.Optional(x),stage=Type.Union([Type.Literal('discovery'),Type.Literal('confirmation')]);
    tools.add('battlecode_control','Queue a durable fresh baseline control through the existing live controller. Spends competition quota; use only for an explicitly requested live objective. Collect with battlecode_collect(stage=discovery), then use its output folder as a preselected control.',{source_group:str,maps:Type.Array(str,{minItems:5,maxItems:5})},a=>this.baselineControl(a).then(r=>this.operationView(r)));
    tools.add('battlecode_inspect','Discover the project baseline, verify frozen source hashes and locate its existing live controllers. Read-only.',{},()=>this.inspect(),true);
    tools.add('battlecode_experiment','Create/list/status durable experiments. Create isolates a candidate and preselects complete discovery and fresh confirmation controls. Never creates live games.',{action:Type.Union(['create','list','status','recover_trial'].map(Type.Literal)),id:opt(str),hypothesis:opt(str),discovery_control:opt(str),confirmation_controls:opt(Type.Array(str)),candidate:opt(str),stage:opt(stage),index:opt(Type.Integer({minimum:0}))},async a=>a.action==='create'?this.create(a).then(d=>this.view(d)):a.action==='list'?this.store.list(this.root).then(list=>list.map(d=>this.view(d))):a.action==='recover_trial'?this.recoverTrial(a.id,a.stage,a.index).then(d=>this.view(d)):this.reconcile(a.id).then(d=>this.view(d)));
    tools.add('battlecode_freeze','Freeze the isolated candidate after adding its startup identity marker to actual source. Refuses to alter a tested candidate.',{id:str},a=>this.freeze(a.id).then(d=>this.view(d)));
    tools.add('battlecode_correctness','Build the frozen candidate with the pinned CLI and run configured correctness commands as one durable background job. Local evidence only.',{id:str},a=>this.correctness(a.id).then(r=>this.operationView(r)));
    tools.add('battlecode_live_trial','Run the existing live controller for one preselected exact fixture group. This spends match quota and briefly changes the shared selector; it restores and verifies the incumbent. Use only for a live objective the user requested. Repeated calls reuse the original operation and never blindly retry creation.',{id:str,stage,index:opt(Type.Integer({minimum:0}))},a=>this.trial(a.id,a.stage,a.index).then(r=>this.operationView(r)));
    tools.add('battlecode_collect','Use the existing collector to download/decode all five replays for the recorded group. Reuses immutable cached downloads.',{id:str,stage,index:opt(Type.Integer({minimum:0}))},a=>this.collect(a.id,a.stage,a.index).then(r=>this.operationView(r)));
    tools.add('battlecode_report','Run the project’s existing paired-report script over collected trials and frozen controls. Produces a report artifact; does not qualify or release a candidate.',{id:str},a=>this.report(a.id).then(r=>this.operationView(r)));
    tools.add('battlecode_decide','Validate actual replay archives, markers, hashes, paired outcomes, runtime faults and rollback receipts. Confirm only on the preselected fresh controls. Qualification is for review; never activates or submits.',{id:str,stage},a=>this.decide(a.id,a.stage).then(d=>this.view(d)));
  }
}
