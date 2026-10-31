import { validAccent, accents } from './theme.mjs';
export const settingItems = [
  {id:'agentMode',label:'Plan / execute mode',special:'mode'},
  {id:'overkill',label:'OVERKILL mode',boolean:true},
  {id:'agents',label:'OVERKILL worker profiles',special:'agents',description:'Independent jobs, models, thinking and limits'},
  {id:'subagentConcurrency',label:'Concurrent subagents',number:[1,16]},
  {id:'checkForUpdates',label:'Check GitHub on startup',boolean:true},
  {id:'autoUpdate',label:'Install updates automatically',boolean:true,description:'Managed releases or clean source checkouts; restart to apply'},
  {id:'accent',label:'Accent colour',values:[...Object.keys(accents),'custom'],description:'Selection, links and the 3D Psi mark'},
  {id:'showLogo',label:'Show logo',boolean:true},{id:'animations',label:'UI animations',boolean:true,description:'Send feedback, response activity and the 3D logo'},{id:'showUsage',label:'Show account usage',boolean:true},
  {id:'autoSwitchAccounts',label:'Automatic account switching',boolean:true,description:'Try another saved account when quota is exhausted'},
  {id:'accountSwitchThreshold',label:'Switch at quota percentage',number:[1,100]},
  {id:'fallbackModels',label:'Cross-provider fallback models',description:'Explicit provider/model routes, comma-separated; empty means same provider only'},
  {id:'quotaRefreshSeconds',label:'Usage refresh interval (seconds)',number:[60,3600]},
  {id:'loopRetrySeconds',label:'Loop retry delay (seconds)',number:[1,300]},
  {id:'model',label:'Main model',special:'model'},{id:'effort',label:'Thinking effort',special:'effort'},
  {id:'summaryModel',label:'Compaction model',description:'Provider/model, or same'},
  {id:'maxOutputTokens',label:'Output tokens per request',number:[256,128000]},
  {id:'toolOutputChars',label:'Tool preview characters',number:[1000,100000]},
  {id:'concurrency',label:'Parallel read tools',number:[1,32]},
  {id:'cacheRetention',label:'Prompt cache retention',values:['short','long','none']},
  {id:'budget',label:'Session budget limit',number:[0,100000],description:'Zero is unlimited. A reached limit keeps a goal waiting for a settings change.'},
  {id:'maxSteps',label:'Request limit per run',number:[0,1000000],description:'Zero is unlimited'},
  {id:'customPrices',label:'API pricing for current model',special:'prices',description:'USD per million input/output/cache tokens; used when provider billing is unavailable'},
  {id:'battlecodeCli',label:'Battlecode CLI path',description:'Pinned compiler/CLI executable for the project adapter'},
  {id:'profile',label:'Agent profile',values:['battlecode','general']},{id:'debug',label:'Operational debug logs',boolean:true},
];
export function validateSettings(patch, registry) {
  for(const [key,value] of Object.entries(patch)) {
    const item=settingItems.find(i=>i.id===key);
    if(key==='accent'&&!validAccent(value))throw new Error('Use a colour name, hex colour or OKLCH colour');
    if(item?.boolean&&typeof value!=='boolean')throw new Error(`${item.label} must be on or off`);
    if(item?.number&&(!Number.isFinite(value)||value<item.number[0]||value>item.number[1]||(key!=='budget'&&!Number.isInteger(value))))throw new Error(`${item.label} must be ${item.number[0]}–${item.number[1]}`);
    if(item?.values&&key!=='accent'&&!item.values.includes(value))throw new Error(`Invalid ${item.label}`);
    if(key==='fallbackModels') {if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))throw new Error('Fallbacks must be provider/model names');for(const m of value)registry?.find(m);}
    if(key==='agentMode'&&!['plan','execute'].includes(value))throw new Error('Choose plan or execute mode.');
    if(key==='agents'){
      if(!Array.isArray(value)||value.length>32||new Set(value.map(a=>a.id)).size!==value.length)throw new Error('Use up to 32 distinct worker profiles.');
      for(const a of value){if(!a.id||!a.name?.trim()||!a.job?.trim()||!['plan','execute'].includes(a.mode))throw new Error('Every worker needs a name, job and mode.');if(a.model)registry?.find(a.model);if(!Number.isInteger(a.maxSteps)||a.maxSteps<1||a.maxSteps>100000)throw new Error('Worker request limits must be 1–100000.');if(a.budget!==undefined&&(!Number.isFinite(a.budget)||a.budget<0))throw new Error('Worker budgets must be nonnegative.');}
    }
    if(key==='customPrices')for(const [model,prices]of Object.entries(value||{})){registry?.find(model);for(const n of Object.values(prices))if(!Number.isFinite(n)||n<0)throw new Error('Prices must be nonnegative USD per million tokens');}
  }
  return patch;
}
