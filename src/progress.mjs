import { Type } from '@earendil-works/pi-ai';
import { atomicJSON } from './storage.mjs';
import { join } from 'node:path';
export function registerProgress(tools,session,onEvent){
 tools.add('progress','Record the current plan and honest estimated completion. Keep the user updated at meaningful tool boundaries. 100% requires verified completion; this is an estimate, not a measured guarantee.',{steps:Type.Array(Type.Object({title:Type.String({minLength:1}),status:Type.Union(['pending','active','complete'].map(Type.Literal))}),{minItems:1,maxItems:50}),update:Type.String({minLength:1}),percent:Type.Optional(Type.Number({minimum:0,maximum:99}))},async a=>{
  const complete=a.steps.filter(s=>s.status==='complete').length,percent=Math.min(99,a.percent??Math.round(complete/a.steps.length*100));
  const progress={...a,percent,at:new Date().toISOString()};await session.event({type:'state',state:{progress}});await atomicJSON(join(session.dir,'plan.json'),progress);onEvent({type:'progress',...progress});return{percent,evidence:join(session.dir,'plan.json')};
 });
}
