export function importantTool(tool){
  if(tool.failed||tool.interrupted)return true;
  const name=tool.call.name,a=tool.call.arguments||{};
  if(name==='agent')return false;
  if(name==='bash'){
    if(tool.duration>=5000||['running','queued','timed_out','failed'].includes(tool.outcome))return true;
    const command=String(a.command||'');
    if(/[><`]|\$\(/.test(command))return true;
    const inspections=command.split(/[\n;&|]+/).map(p=>p.trim()).filter(Boolean);
    return !inspections.length||!inspections.every(p=>/^(?:pwd|ls|find|rg|grep|sed|head|tail|cat|wc|stat|du|file|git\s+(?:status|diff|log|show|rev-parse))\b/.test(p));
  }
  if(name==='job')return a.action==='stop'||['running','queued'].includes(tool.outcome);
  if(name==='browser')return ['evaluate','screenshot'].includes(a.action);
  return !['read','search','fetch','search_web','battlecode_inspect','checkpoint','progress','session_title'].includes(name);
}
