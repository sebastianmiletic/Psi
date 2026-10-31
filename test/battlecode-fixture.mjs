import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Session } from '../src/session.mjs';
import { Jobs } from '../src/jobs.mjs';
import { Battlecode } from '../src/battlecode.mjs';

const setup = String.raw`
import json,sys,pathlib,zipfile,hashlib
root=pathlib.Path(sys.argv[1])
for label,prefix in [('discovery','d'),('confirmation','c')]:
 out=root/'controls'/label;(out/'replays').mkdir(parents=True)
 maps=[prefix+str(i) for i in range(5)];sides=['a','b','a','b','a'];rows=[];matches=[]
 for i,m in enumerate(maps):
  mid=prefix+'-baseline-'+str(i);side=0 if sides[i]=='a' else 1;win=i in (0,2)
  replay=out/'replays'/(mid+'.repl26a')
  with zipfile.ZipFile(replay,'w') as z:z.writestr('team-'+sides[i]+'.stdout','baseline');z.writestr('team-'+('b' if sides[i]=='a' else 'a')+'.stdout','opponent')
  rows.append(dict(match=mid,map=m,map_id=m,side=side,win=win,bank=[100,90] if win else [90,100],marker_verified=False,logged_errors=[],actions={'fuel':0,'error':0},replay_sha256=hashlib.sha256(replay.read_bytes()).hexdigest()))
  matches.append(dict(matchId=mid,mapId=m,status='finished',position=i+1,teams=[dict(teamId='our-team',side=sides[i],result='win' if win else 'loss',engineVersion='2.0.0'),dict(teamId='opponent',side='b' if sides[i]=='a' else 'a',result='loss' if win else 'win',engineVersion='2.0.0')]))
 fixture=dict(maps=maps,sides=sides,opponent='opponent')
 (out/'receipt.json').write_text(json.dumps(dict(group_id=label+'-control',version=248,baseline=248,fixture=fixture)))
 (out/'group.json').write_text(json.dumps(dict(matches=matches)))
 (out/'results.json').write_text(json.dumps(rows))
`;
const trial = String.raw`
import json,sys,pathlib,zipfile,hashlib,argparse
OUR='our-team'
root=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--baseline',type=int);p.add_argument('--source-group');p.add_argument('--baseline-maps');p.add_argument('--candidate');p.add_argument('--version',type=int);p.add_argument('--marker');p.add_argument('--note');p.add_argument('--out');a=p.parse_args()
label='discovery' if a.source_group.startswith('discovery') else 'confirmation'
control=root/'controls'/label;old=json.loads((control/'receipt.json').read_text());out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=False)
marker=a.marker or (json.loads((pathlib.Path(a.candidate)/'experiment.json').read_text())['identity_marker'] if a.candidate else None)
if a.baseline_maps:old['fixture']['maps']=a.baseline_maps.split(',')
version=a.version or 249
receipt=dict(group_id=label+'-candidate',version=version,baseline=a.baseline,source_group=a.source_group,candidate=a.candidate,fixture=old['fixture'],identity_marker=marker,baseline_selected_after=True,baseline_active_after=True,jobs_finished_and_baseline_active=True)
(out/'receipt.json').write_text(json.dumps(receipt));(out/'settled-state.json').write_text(json.dumps(dict(active={'version':248},selected={'version':248},pinned=True)))
scenario=json.loads((root/'scenario.json').read_text()) if (root/'scenario.json').exists() else {}
if scenario.get('cancel_delay'):
 import signal,time
 def cleanup(signum,frame):
  signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(2.2);(root/'cleanup-finished.txt').write_text('incumbent restored');sys.exit(1)
 signal.signal(signal.SIGTERM,cleanup);(root/'controller-ready.txt').write_text('ready');time.sleep(30)
rows=[];matches=[];(out/'replays').mkdir()
for i,m in enumerate(old['fixture']['maps']):
 side=0 if old['fixture']['sides'][i]=='a' else 1;win=i in (0,1,2)
 if scenario.get('regression') and i==0:win=False
 mid=label+'-candidate-'+str(i);replay=out/'replays'/(mid+'.repl26a')
 with zipfile.ZipFile(replay,'w') as z:z.writestr('team-'+('a' if side==0 else 'b')+'.stdout','wrong marker' if scenario.get('omit_marker') else marker or 'baseline')
 rows.append(dict(match=mid,map=m,map_id=m,side=side,win=win,bank=[100,90] if win else [90,100],marker=marker,marker_verified=True,logged_errors=[],actions={'fuel':0,'error':0},replay_sha256=hashlib.sha256(replay.read_bytes()).hexdigest()))
 matches.append(dict(matchId=mid,mapId=m,status='finished',position=i+1,teams=[dict(teamId=OUR,side='a' if side==0 else 'b',result='win' if win else 'loss',engineVersion='2.0.0'),dict(teamId='opponent',side='b' if side==0 else 'a',result='loss' if win else 'win',engineVersion='2.0.0')]))
(out/'prepared-results.json').write_text(json.dumps(rows));(out/'group.json').write_text(json.dumps(dict(matches=matches)))
with (root/'queue-count.txt').open('a') as f:f.write(label+'\n')
`;
export async function battlecodeFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'psi-battlecode-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const baseline=join(root,'bots/vision-v6');await mkdir(join(baseline,'src'),{recursive:true});await writeFile(join(baseline,'src/main.cpp'),'int main(){return 0;}');
  await writeFile(join(baseline,'manifest.json'),JSON.stringify({platform_version:248,files:{'main.cpp':createHash('sha256').update('int main(){return 0;}').digest('hex')}}));
  await writeFile(join(root,'README.md'),'VisionV6 v248 frozen in `bots/vision-v6`');await mkdir(join(root,'tools/vision'),{recursive:true});
  await writeFile(join(root,'tools/vision/live_trial.py'),trial);
  await writeFile(join(root,'tools/vision/live_collect.py'),"import sys,pathlib,shutil\nout=pathlib.Path(sys.argv[1]);shutil.copyfile(out/'prepared-results.json',out/'results.json')\n");
  await writeFile(join(root,'tools/vision/live_report.py'),"import sys\nprint('Existing project report ran')\n");
  await writeFile(join(root,'tools/vision/check_observation.py'),"print('Correctness fixture passed')\n");
  const cli=join(root,'cambc');await writeFile(cli,"#!/usr/bin/env python3\nimport sys,pathlib,hashlib\nif '--version' in sys.argv: print('cambc 4.0.0');sys.exit()\nbot=pathlib.Path(sys.argv[2]);out=bot/'.cambc/build-release';out.mkdir(parents=True,exist_ok=True);(out/'bot-injected.wasm').write_bytes(hashlib.sha256((bot/'src/main.cpp').read_bytes()).digest())\n");await chmod(cli,0o755);
  const prepared=spawnSync('python3',['-c',setup,root],{encoding:'utf8'});if(prepared.status!==0)throw new Error(prepared.stderr);
  const home=join(root,'psi-home'),session=await Session.create(root,home),jobs=new Jobs(home,session.meta.id),config={battlecodeCli:cli};
  const adapter=new Battlecode({session,jobs,config,home});
  const create=()=>adapter.create({hypothesis:'Improve one measured capture decision',discovery_control:'controls/discovery',confirmation_controls:['controls/confirmation']});
  const freeze=async exp=>{await writeFile(join(exp.candidate,'src/main.cpp'),`// ${exp.marker}\nint main(){return 0;}`);return adapter.freeze(exp.id);};
  const awaitOperation=async result=>{const job=await jobs.awaitCompletion(result.operation.jobId);if(job.status!=='completed')throw new Error(await jobs.tail(job.id));return adapter.reconcile(result.experiment.id);};
  const check=async exp=>awaitOperation(await adapter.correctness(exp.id));
  const panel=async(exp,stage)=>{await awaitOperation(await adapter.trial(exp.id,stage));await awaitOperation(await adapter.collect(exp.id,stage));return adapter.decide(exp.id,stage);};
  return{root,home,session,jobs,config,adapter,create,freeze,check,panel,awaitOperation};
}
