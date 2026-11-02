import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function requestMetrics(payload,{route,purpose,previousHash}){
 const instructions=payload.instructions??payload.system??payload.messages?.filter(m=>['system','developer'].includes(m.role))??'';
 const tools=payload.tools||[],prefix={instructions,tools},prefixHash=hash(prefix);
 const input=payload.input??payload.messages?.filter(m=>!['system','developer'].includes(m.role))??[];
 return{type:'request_metrics',route,purpose,prefixHash,prefixChanged:!!previousHash&&previousHash!==prefixHash,systemCharacters:JSON.stringify(instructions).length,toolCharacters:JSON.stringify(tools).length,inputCharacters:JSON.stringify(input).length,messageCount:Array.isArray(input)?input.length:null,toolCount:tools.length};
}
