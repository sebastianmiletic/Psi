import test from 'node:test';
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './helpers.mjs';
import {TerminalUI} from '../src/ui.mjs';
import {MemoryTerminal} from './terminal.mjs';

function firstStream(f,make){
 const original=f.app.registry.forRequest.bind(f.app.registry);let calls=0;
 f.app.registry.forRequest=async(...args)=>{const route=await original(...args),stream=route.models.streamSimple.bind(route.models);route.models.streamSimple=(...values)=>++calls===1?make(...values):stream(...values);return route;};
 return()=>calls;
}
const resultStream=result=>({async *[Symbol.asyncIterator](){},async result(){return result;}});

test('a real disconnected provider stream reconnects without executing incomplete tool calls or reporting a user stop',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{text:'Partial reply',call:{name:'write',args:{path:'never-execute.txt',content:'unsafe partial call'}},disconnect:true}:{text:'Recovered complete reply.'});
 const terminal=new MemoryTerminal(100,32),ui=new TerminalUI(f.app,{terminal});f.app.ui=ui;t.after(()=>ui.stop());ui.start();
 await f.app.submit('Recover the connection');ui.tui.renderNow();
 assert.equal(f.requests.length,2);assert.equal(f.session.status,'idle');assert.equal(f.events.filter(e=>e.type==='retry').length,1);assert.match(f.events.find(e=>e.type==='retry').error,/connection lost/i);assert.ok(!f.events.some(e=>e.type==='stopped'||e.type==='error'));assert.equal(await stat(join(f.root,'never-execute.txt')).catch(()=>null),null);
 const assistants=f.session.messages.filter(m=>m.role==='assistant');assert.equal(assistants.length,1);assert.match(JSON.stringify(assistants),/Recovered complete reply/);assert.doesNotMatch(ui.tui.getScreenLines().join('\n'),/terminated|Request aborted|· stopped/);
});

test('an adapter abort without a user abort reconnects and never claims the user stopped it',async t=>{
 const f=await fixture(t,()=>({text:'Recovered adapter response.'}));const calls=firstStream(f,()=>resultStream({stopReason:'aborted',errorMessage:'terminated'}));
 await f.app.engine.run('Recover the adapter');assert.equal(calls(),2);assert.equal(f.requests.length,1);assert.equal(f.session.status,'idle');assert.equal(f.events.filter(e=>e.type==='retry').length,1);assert.ok(!f.events.some(e=>e.type==='stopped'));
});

test('exhausted connection retries pause without terminating the task and user stop cancels waiting',async t=>{
 const f=await fixture(t,()=>({disconnect:true})),observe=f.app.options.onEvent;
 f.app.options.onEvent=e=>{observe(e);if(e.type==='waiting')f.app.engine.stop();};
 await f.app.engine.run('Recover a persistent outage');assert.equal(f.requests.length,2);assert.ok(f.events.some(e=>e.type==='waiting'&&/provider connection/.test(e.reason)));assert.ok(!f.events.some(e=>e.type==='error'));assert.equal(f.session.status,'stopped');
});

test('a genuine user stop cancels a request without reconnecting',async t=>{
 const f=await fixture(t,()=>({text:'Should not run'}));const calls=firstStream(f,(_model,_context,options)=>({async *[Symbol.asyncIterator](){f.app.engine.stop();options.signal.throwIfAborted();},async result(){throw new Error('Should not complete');}}));
 await f.app.engine.run('Wait for my stop');assert.equal(calls(),1);assert.equal(f.requests.length,0);assert.equal(f.session.status,'stopped');assert.ok(f.events.some(e=>e.type==='stopped'));assert.ok(!f.events.some(e=>e.type==='retry'));
});

test('an internal AbortError recovers when the user cancellation signal is still live',async t=>{
 const f=await fixture(t,()=>({text:'Recovered internal abort.'}));const calls=firstStream(f,()=>({async *[Symbol.asyncIterator](){throw new DOMException('The operation was aborted.','AbortError');},async result(){throw new Error('Should not complete');}}));
 await f.app.engine.run('Recover an internal transport abort');assert.equal(calls(),2);assert.equal(f.session.status,'idle');assert.ok(!f.events.some(e=>e.type==='stopped'));assert.match(f.events.find(e=>e.type==='retry').error,/connection lost/i);
});

test('stopping during reconnect backoff prevents any further provider request',async t=>{
 const f=await fixture(t,()=>({disconnect:true})),observe=f.app.options.onEvent;f.app.options.onEvent=e=>{observe(e);if(e.type==='retry')f.app.engine.stop();};
 await f.app.engine.run('Stop while reconnecting');assert.equal(f.requests.length,1);assert.equal(f.session.status,'stopped');assert.ok(f.events.some(e=>e.type==='stopped'));
});

test('reconnect attempts obey the request ceiling rather than bypassing it',async t=>{
 const f=await fixture(t,()=>({disconnect:true}));f.app.engine.config.maxSteps=1;
 await assert.rejects(f.app.engine.run('Bounded reconnect'),/request|ceiling|limit/i);assert.equal(f.requests.length,1);assert.equal(f.session.status,'limited');assert.ok(!f.events.some(e=>e.type==='stopped'));
});

 test('a normal task recovers after waiting through a full failed connection batch',async t=>{
 const f=await fixture(t,(_p,n)=>n<=2?{disconnect:true}:{text:'Recovered without restarting the task.'}),observe=f.app.options.onEvent;
 f.app.options.onEvent=e=>{observe(e);if(e.type==='waiting')setTimeout(()=>f.app.engine.wake?.(),5);};
 await f.app.engine.run('Keep working after the outage');assert.equal(f.requests.length,3);assert.equal(f.session.status,'idle');assert.ok(f.events.some(e=>e.type==='waiting'));assert.ok(!f.events.some(e=>e.type==='stopped'||e.type==='error'));assert.equal(f.session.messages.filter(m=>m.role==='user'&&!m.internal).length,1);
});

test('a completed task still delivers its final review after a connection outage during finalization',async t=>{
 const f=await fixture(t,(_p,n)=>n===1?{call:{name:'write',args:{path:'proof.txt',content:'verified'}}}:n===2?{call:{name:'finish',args:{summary:'Verified task',evidence:['proof.txt']}}}:n<=4?{disconnect:true}:{text:'Verified final review after reconnect.'}),observe=f.app.options.onEvent;
 f.app.options.onEvent=e=>{observe(e);if(e.type==='waiting')setTimeout(()=>f.app.engine.wake?.(),5);};
 await f.app.engine.run('Finish and provide a review');assert.equal(f.requests.length,5);assert.equal(f.session.status,'idle');assert.match(JSON.stringify(f.session.conversation.at(-1)),/Verified final review/);assert.ok(f.events.some(e=>e.type==='waiting'));assert.ok(!f.events.some(e=>e.type==='stopped'||e.type==='error'));
});
