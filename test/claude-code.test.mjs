import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './helpers.mjs';
import {claudeProvider,claudeStreams,runClaude} from '../src/claude-code.mjs';
import {loadConfig,saveConfig} from '../src/storage.mjs';

const result=(body,extra={})=>({type:'result',is_error:false,structured_output:body,usage:{input_tokens:25,output_tokens:5,cache_read_input_tokens:10,cache_creation_input_tokens:2},...extra});

test('Claude Code uses its native login, bridges tool turns and keeps tool execution inside Psi',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let turns=0;
 const native=claudeProvider(f.app.registry.models.getModels('anthropic'),f.app.config,f.app.home,{status:async()=>({loggedIn:true,authMethod:'claude.ai',configDirectory:join(f.root,'native-auth')}),run:async(executable,args,opts)=>{
  turns++;assert.equal(executable,'claude');assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--no-session-persistence'));assert.ok(args.includes('--strict-mcp-config'));assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks,true);assert.equal(args[args.indexOf('--setting-sources')+1],'');
  assert.equal(opts.directory,process.env.CLAUDE_CONFIG_DIR||null);assert.notEqual(opts.cwd,f.root);
  if(turns===2)assert.ok(JSON.parse(opts.input).some(m=>m.role==='toolResult'&&m.toolName==='write'));
  opts.onLine(JSON.stringify(result(turns===1?{text:'I will create the requested file.',calls:[{name:'write',arguments_json:JSON.stringify({path:'native.txt',content:'verified'})}]}:{text:'Created native.txt and verified the result.',calls:[]})));
  return{code:0,stderr:''};
 }});
 f.app.registry.models.setProvider(native);
 const accountId=await f.app.registry.accounts.login(f.app.registry,'anthropic','Native','oauth',{signal:new AbortController().signal,prompt:async()=> 'current',notify(){}});
 assert.equal((await f.app.registry.accounts.selected('claude-code')).id,accountId);
 assert.equal(f.app.registry.billingMode(await f.app.registry.accounts.selected('claude-code')),'subscription');
 const data=await f.app.registry.accounts.data();assert.equal(data.accounts.length,1);assert.equal(data.accounts[0].credential.access,undefined);assert.equal(data.accounts[0].credential.refresh,undefined);assert.ok(data.accounts[0].credential.env.PSI_CLAUDE_DEFAULT_CONFIG==='1'||data.accounts[0].credential.env.CLAUDE_CONFIG_DIR===process.env.CLAUDE_CONFIG_DIR);
 await f.app.update({model:'claude-code/claude-sonnet-4-6',effort:'medium'});
 await f.app.engine.run('Create native.txt with verified');assert.equal(turns,2);assert.equal(await readFile(join(f.root,'native.txt'),'utf8'),'verified');assert.equal(f.requests.length,0);assert.equal(f.session.totals.requests,2);assert.equal(f.session.totals.input,50);assert.equal(f.session.totals.cacheRead,20);
});

test('native Claude connection refuses malformed results, unavailable tools and image input without executing them',async()=>{
 const model={id:'test',provider:'claude-code',api:'claude-code',cost:{}};let body={text:'',calls:[{name:'bash',arguments:{command:'wrong'}}]},calls=0;
 const api=claudeStreams('fixture',{run:async(_e,_a,o)=>{calls++;o.onLine(JSON.stringify(result(body)));return{code:0,stderr:''};}});
 const ask=async context=>api.streamSimple(model,context,{}).result();
 assert.match((await ask({messages:[],tools:[]})).errorMessage,/unavailable tool/);
 body=null;assert.match((await ask({messages:[]})).errorMessage,/valid structured/);
 assert.match((await ask({messages:[{role:'user',content:[{type:'image',data:'fixture'}]}]})).errorMessage,/image input/);assert.equal(calls,2);
});

test('another Claude account uses a separate native directory and native failures retain usage receipts',async t=>{
 const f=await fixture(t,()=>({text:'unused'}));let signedIn=false,loginDirectory;
 const provider=claudeProvider(f.app.registry.models.getModels('anthropic'),f.config,f.app.home,{status:async()=>({loggedIn:signedIn,authMethod:'claude.ai'}),run:async(_e,args,o)=>{assert.deepEqual(args,['auth','login']);loginDirectory=o.directory;signedIn=true;return{code:0};}});
 const credential=await provider.auth.apiKey.login({signal:new AbortController().signal,prompt:async()=> 'separate',notify(){}});
 assert.ok(loginDirectory.startsWith(join(f.app.home,'claude-accounts')));assert.equal(credential.env.CLAUDE_CONFIG_DIR,loginDirectory);assert.equal(credential.access,undefined);
 const model={id:'test',api:'claude-code',provider:'claude-code',cost:{input:1,output:2,cacheRead:0.1,cacheWrite:1}};
 const api=claudeStreams('fixture',{run:async(_e,_a,o)=>{o.onLine(JSON.stringify(result(null,{is_error:true,errors:['native turn limit reached']})));return{code:1,stderr:''};}});
 const failure=await api.streamSimple(model,{messages:[]},{}).result();assert.match(failure.errorMessage,/turn limit/);assert.equal(failure.usage.totalTokens,42);
});

test('native Claude subprocess handles stdin and cancellation without invoking a shell',async()=>{
 const r=await runClaude(process.execPath,['-e','process.stdin.on("data",d=>process.stdout.write(d));'],{input:'literal $(echo never-run)'});assert.equal(r.code,0);assert.equal(r.output,'literal $(echo never-run)');
 const controller=new AbortController(),pending=runClaude(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});setTimeout(()=>controller.abort(new Error('User stopped')),30);await assert.rejects(pending,/User stopped/);
});

test('legacy worker profiles are ignored on load and resume without affecting the default model',async t=>{
 const f=await fixture(t,()=>({text:'unused'})),legacy=[{id:'researcher',name:'Researcher',job:'Research only',model:null,mode:'plan',effort:'medium',maxSteps:80}];
 await writeFile(join(f.app.home,'config.json'),JSON.stringify({...f.config,agents:legacy,subagentConcurrency:1}));
 const c=await loadConfig(f.app.home);assert.equal(c.agents,undefined);assert.equal(c.subagentConcurrency,undefined);
 f.session.state.settings={agents:legacy,subagentConcurrency:1};f.app.bind();assert.equal(f.app.engine.config.agents,undefined);assert.equal(f.app.engine.config.subagentConcurrency,undefined);
 let items;f.app.ui={stop(){},choose:async(_title,rows)=>{items=rows;return null;}};await f.app.agentsMenu();assert.ok(items.some(i=>i.value==='default-model'));assert.ok(!items.some(i=>/profile|add|concurrency/.test(i.value)));assert.equal(f.requests.length,0);
 await saveConfig({subagentModel:'openai-codex/gpt-5.6-sol'},f.app.home);const saved=JSON.parse(await readFile(join(f.app.home,'config.json')));assert.equal(saved.subagentModel,'openai-codex/gpt-5.6-sol');assert.equal(saved.agents,undefined);
});
