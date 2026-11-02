import { join } from 'node:path';
import { readJSON,atomicJSON } from './storage.mjs';
import { Session } from './session.mjs';
import { App } from './app.mjs';
import { VerificationReceipts } from './evidence.mjs';
const verification=new VerificationReceipts();
let activityWrites=Promise.resolve(),appActivity=null;
const spec=await readJSON(process.argv[2],null),session=await Session.load(spec.sessionId,spec.home,{parentSession:spec.parentSession}),app=new App(spec.config,session,{home:spec.home,onEvent:e=>{verification.event(e);if(e.type==='tool_start')console.log(`tool: ${e.call.name}`);const activity=e.type==='tool_start'?e.call.name:e.type==='request_start'?'reasoning':e.type==='text_delta'?'responding':e.type==='waiting'?'waiting':null;if(activity&&activity!==appActivity){appActivity=activity;activityWrites=activityWrites.then(()=>atomicJSON(join(session.dir,'activity.json'),{activity,at:Date.now()})).catch(()=>{});}}});
let stopping=false;
const stop=()=>{stopping=true;app.engine.stop();};
for(const name of ['SIGINT','SIGTERM'])process.on(name,stop);
const checkStop=async()=>{if(process.env.PSI_JOB_CONTROL_DIR&&await readJSON(join(process.env.PSI_JOB_CONTROL_DIR,'stop-request.json'),null))stop();};
const seen=new Set(await readJSON(join(session.dir,'inbox-seen.json'),[]));let polling=false;
const timer=setInterval(async()=>{if(polling)return;polling=true;try{await checkStop();for(const m of await readJSON(join(session.dir,'inbox.json'),[]))if(!seen.has(m.id)){await app.engine.steer(m.text);seen.add(m.id);await atomicJSON(join(session.dir,'inbox-seen.json'),[...seen]);}}catch{}finally{polling=false;}},500);timer.unref();
try{
 const {clampThinkingLevel}=await import('@earendil-works/pi-ai');app.engine.config.effort=clampThinkingLevel(app.engine.model,app.engine.config.effort);
 await checkStop();if(!stopping)await app.engine.run(spec.prompt);
 const summary=session.conversation.filter(m=>m.role==='assistant').at(-1)?.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'No final response. Inspect the child journal.';
 await atomicJSON(join(session.dir,'worker-result.json'),{status:session.status,summary,verification:verification.report(spec.checks),totals:session.totals,session:session.meta.id});
}catch(e){await atomicJSON(join(session.dir,'worker-result.json'),{status:'error',error:e.message,verification:verification.report(spec.checks),totals:session.totals});process.exitCode=1;}
finally{await activityWrites;clearInterval(timer);if(stopping)for(const j of await app.jobs.list())if(j.sessionId===session.meta.id&&['running','queued'].includes(j.status)){await app.jobs.stop(j.id);await app.jobs.awaitCompletion(j.id).catch(()=>{});}await app.close();}
