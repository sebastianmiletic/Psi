export class ConnectionUnavailableError extends Error {}
const pattern=/\bterminated\b|termination|premature.{0,12}close|other side closed|UND_ERR_(?:SOCKET|ABORTED|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ERR_STREAM_PREMATURE_CLOSE|ECONN(?:RESET|REFUSED|ABORTED)|EPIPE|fetch failed|socket|provider connection interrupted|(?:operation|request|stream) (?:was )?aborted|stream.{0,16}(?:disconnect|closed|reset)/i;
export function connectionFailure(error){
 const seen=new Set();let current=error;
 for(let i=0;current&&i<6;i++){
  if(typeof current==='string')return pattern.test(current);
  if(seen.has(current))break;seen.add(current);
  if(['AbortError','TimeoutError'].includes(current.name)||pattern.test([current.code,current.message].filter(Boolean).join(' ')))return true;
  current=current.cause;
 }
 return false;
}
