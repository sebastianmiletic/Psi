import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {boundedFetch} from '../src/tools.mjs';
import {connectionFailure} from '../src/connection.mjs';
async function site(t,handler){const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});return 'http://127.0.0.1:'+server.address().port;}

test('website body termination retries the entire GET and discards the partial download',async t=>{
 let requests=0;const url=await site(t,async(_req,res)=>{requests++;if(requests===1){res.writeHead(200,{'content-length':'1000'});res.write('Incomplete stale bytes');await delay(20);res.destroy();}else res.end('Complete fresh page');});
 const result=await boundedFetch(url);assert.equal(result.text,'Complete fresh page');assert.equal(requests,2);
});
test('website connection failure is bounded and reports the failed download rather than task termination',async t=>{
 let requests=0;const url=await site(t,async(_req,res)=>{requests++;res.writeHead(200,{'content-length':'1000'});res.write('Partial');await delay(10);res.destroy();});
 await assert.rejects(boundedFetch(url),/Website connection lost/);assert.equal(requests,3);
});
test('read-only retries preserve response size limits and do not retry ordinary HTTP failures',async t=>{
 let requests=0;const url=await site(t,(req,res)=>{requests++;if(req.url==='/missing'){res.writeHead(404);res.end();}else res.end('x'.repeat(100));});
 await assert.rejects(boundedFetch(url,{maxBytes:10}),/exceeds/);assert.equal(requests,1);await assert.rejects(boundedFetch(url+'/missing'),/HTTP 404/);assert.equal(requests,2);
});
test('cancelling a website download stops immediately and never retries it',async t=>{
 const controller=new AbortController();let requests=0;const url=await site(t,async(_req,res)=>{requests++;res.writeHead(200,{'content-length':'1000'});res.write('Partial');controller.abort(new Error('Stopped by user'));res.destroy();});
 await assert.rejects(boundedFetch(url,{signal:controller.signal}),/Stopped by user/);assert.equal(requests,1);
});
test('connection classification recognizes nested transport errors without treating application errors as cancellation',()=>{
 assert.equal(connectionFailure(new Error('Transport failed',{cause:{code:'ERR_STREAM_PREMATURE_CLOSE'}})),true);assert.equal(connectionFailure({code:'UND_ERR_ABORTED'}),true);assert.equal(connectionFailure('stream disconnected unexpectedly'),true);assert.equal(connectionFailure('Connection termination'),true);assert.equal(connectionFailure('This operation was aborted'),true);assert.equal(connectionFailure({name:'TimeoutError'}),true);assert.equal(connectionFailure('HTTP 401 Invalid API key'),false);assert.equal(connectionFailure('context length exceeded'),false);
 const loop={message:'Ordinary failure'};loop.cause=loop;assert.equal(connectionFailure(loop),false);
});
