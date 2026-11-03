import {importantTool} from './activity-kind.mjs';
const textContent=content=>typeof content==='string'?content:(Array.isArray(content)?content:[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
function quiet(entry){
 if(entry.kind!=='tool'||!entry.result)return false;
 let outcome;if(['bash','job'].includes(entry.call.name))try{outcome=JSON.parse(textContent(entry.result.content))?.status;}catch{}
 return !importantTool({call:entry.call,failed:entry.result.isError,outcome});
}
export class TranscriptHistory{
 constructor({limit=300,maxBytes=8_000_000}={}){this.entries=[];this.calls=new Map();this.workers=new Map();this.launched=new Set();this.limit=limit;this.maxBytes=maxBytes;this.bytes=0;}
 trim(){
  while(this.entries.length>1&&(this.entries.length>this.limit||this.bytes>this.maxBytes)){
   const index=this.entries.findIndex(entry=>entry.quiet===true),entry=this.entries.splice(index<0?0:index,1)[0];this.bytes-=entry.bytes;
   if(entry.kind==='tool'&&this.calls.get(entry.call.id)===entry)this.calls.delete(entry.call.id);
  }
 }
 push(entry){entry.bytes=JSON.stringify(entry).length;this.entries.push(entry);this.bytes+=entry.bytes;if(entry.kind==='tool')this.calls.set(entry.call.id,entry);this.trim();return entry;}
 message(message){
  const content=textContent(message.content)||(message.role==='user'&&Array.isArray(message.content)&&message.content.some(c=>c.type==='image')?'[Attached content]':'');if(!content.trim())return;
  this.push({kind:'message',message:{role:message.role,content,timestamp:message.timestamp,...(message.partial?{partial:true}:{}),...(message.finalReview?{finalReview:true}:{})}});
 }
 observe(event,state){
  if(event.type==='message'){
   const message=event.message;
   if(message.role==='assistant'&&Array.isArray(message.content))for(const call of message.content.filter(c=>c.type==='toolCall')){
    const args={...call.arguments};delete args.content;
    this.push({kind:'tool',call:{type:'toolCall',id:call.id,name:call.name,arguments:args}});
   }
   if(message.role==='toolResult'){
    const entry=this.calls.get(message.toolCallId)||this.push({kind:'tool',call:{type:'toolCall',id:message.toolCallId,name:message.toolName,arguments:{}}});
    this.bytes-=entry.bytes;entry.result={isError:!!message.isError,content:typeof message.content==='string'?[{type:'text',text:message.content}]:(Array.isArray(message.content)?message.content:[]).filter(c=>c.type==='text')};entry.quiet=quiet(entry);entry.bytes=JSON.stringify({...entry,bytes:undefined}).length;this.bytes+=entry.bytes;this.trim();
   }
   if(message.internal&&message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('Subagent reports ('))this.reports(message.content);
  }
  if(event.type==='state'){
   for(const worker of Array.isArray(event.state?.agents)?event.state.agents:[]){
    if(!worker||typeof worker.name!=='string')continue;
    this.workers.set(worker.name,worker);const key=worker.id+':'+worker.jobId;if(this.launched.has(key))continue;this.launched.add(key);
    this.push({kind:'worker',event:{type:'agent_started',agent:{id:worker.id,name:worker.name,group:worker.group,model:worker.model,createdAt:worker.createdAt,status:'running'}}});
   }
   const progress=event.state?.progress;
   if(progress?.update&&!progress.verified){const key=JSON.stringify(progress);if(key!==this.progressKey){this.progressKey=key;this.push({kind:'progress',update:progress.update,steps:Array.isArray(progress.steps)?progress.steps:[],mode:state.settings?.agentMode});}}
  }
 }
 reports(content){
  // Existing journals already contain the exact delivered report batch. Only
  // recognize headers for workers actually recorded in this parent session.
  const headers=[...content.matchAll(/^(.{1,80}) \[([a-z_]+)\]\r?\n/gm)].filter(m=>this.workers.has(m[1]));
  for(let i=0;i<headers.length;i++){
   const header=headers[i],worker=this.workers.get(header[1]),body=content.slice(header.index+header[0].length,headers[i+1]?.index??content.length);
   const summary=body.split('\nFull report:')[0].split('\nVerification receipts:')[0].trim();
   this.push({kind:'worker',event:{type:'agent_finished',agent:{id:worker.id,name:worker.name,group:worker.group,model:worker.model,status:header[2],result:{summary}}}});
  }
 }
 view(streaming){return streaming?.text?[...this.entries,{kind:'message',message:{role:'assistant',content:streaming.text,partial:true,timestamp:streaming.timestamp}}]:this.entries;}
}
