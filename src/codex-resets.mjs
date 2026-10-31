// Optional Codex app-server bridge, started only for user-invoked account and reset menus.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export class CodexResetClient {
 constructor({command='codex',prefix=[],signal,timeout=20000}={}){
  this.next=1;this.pending=new Map();this.timeout=timeout;this.closed=false;this.signal=signal;
  const env={...process.env};for(const key of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)$/.test(key))delete env[key];
  this.child=spawn(command,[...prefix,'app-server','--stdio','-c','cli_auth_credentials_store="ephemeral"','-c','chatgpt_base_url="https://chatgpt.com/backend-api/"','-c','analytics.enabled=false'],{cwd:tmpdir(),env,stdio:['pipe','pipe','ignore'],windowsHide:true});
  this.exit=new Promise(resolve=>{this.child.once('close',()=>{this.fail(new Error('Codex reset connection closed'));resolve();});this.child.once('error',()=>{this.fail(new Error('Install or update Codex CLI for reset credits'));resolve();});});
  this.child.stdin.on('error',()=>this.fail(new Error(this.child.pid?'Codex reset connection closed':'Install or update Codex CLI for reset credits')));
  let buffer='';this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{
   buffer+=chunk;if(Buffer.byteLength(buffer)>2_000_000){this.fail(new Error('Codex reset response too large'));this.child.kill();return;}
   let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{this.receive(JSON.parse(line));}catch{this.fail(new Error('Invalid Codex reset response'));}}
  });
  this.abort=()=>{this.fail(new Error('Cancelled'));this.child.kill();};signal?.addEventListener('abort',this.abort,{once:true});if(signal?.aborted)this.abort();
 }
 send(value){if(this.closed)throw new Error('Codex reset connection closed');this.child.stdin.write(JSON.stringify(value)+'\n');}
 fail(error){this.failure=error;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 receive(value){
  if(value.method&&value.id!==undefined){
   if(value.method==='account/chatgptAuthTokens/refresh'&&this.tokens){void this.tokens().then(result=>this.send({id:value.id,result})).catch(()=>{if(!this.closed)this.send({id:value.id,error:{code:-32000,message:'Account credentials unavailable'}});});}
   else this.send({id:value.id,error:{code:-32601,message:'Unsupported request'}});return;
  }
  const p=this.pending.get(value.id);if(!p)return;this.pending.delete(value.id);clearTimeout(p.timer);
  if(value.error)p.reject(new Error(value.error.code===-32601?'Update Codex CLI for reset credits':`Codex reset request failed (${value.error.code||'service error'})`));else p.resolve(value.result);
 }
 request(method,params={}){
  if(this.failure||this.closed)return Promise.reject(this.failure||new Error('Codex reset connection closed'));
  return new Promise((resolve,reject)=>{const id=this.next++;const timer=setTimeout(()=>{this.fail(new Error('Codex reset request timed out'));this.child.kill();},this.timeout);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){this.fail(e);}});
 }
 async initialize(){
  await this.request('initialize',{clientInfo:{name:'psi_resets',title:'Psi',version:'1'},capabilities:{experimentalApi:true,explicitGatewayOauth:true,requestAttestation:false}});this.send({method:'initialized'});
  const result=await this.request('config/read',{includeLayers:false});
  if(result?.config?.cli_auth_credentials_store!=='ephemeral'||result.config.chatgpt_base_url!=='https://chatgpt.com/backend-api/')throw new Error('Codex requires in-memory auth and the official service for resets');
 }
 async login(tokens){this.tokens=tokens;const value=await tokens();await this.request('account/login/start',{type:'chatgptAuthTokens',...value});}
 async close(){if(this.closed)return;this.closed=true;this.signal?.removeEventListener('abort',this.abort);this.fail(new Error('Codex reset connection closed'));this.child.stdin.end();const timer=setTimeout(()=>this.child.kill('SIGKILL'),1500);this.child.kill();try{await this.exit;}finally{clearTimeout(timer);}}
}
export async function withCodexResetClient(options,tokens,fn){const client=new CodexResetClient(options);try{await client.initialize();await client.login(tokens);return await fn(client);}finally{await client.close();}}
