import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/storage.mjs';
import { Session } from '../src/session.mjs';
import { App } from '../src/app.mjs';

export async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'psi-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [], requestHeaders = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Fixture</title></head><body><main><h1>Published results</h1><p>24 games, 18 wins.</p><script>untrusted()</script><a href="/data">Data</a></main></body></html>'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('Not found'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload); requestHeaders.push(req.headers);
    try {
      const answer = await respond(payload, requests.length, server.address().port);
      if (answer.httpError) { res.writeHead(answer.httpError, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: answer.message || 'temporary overload' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(answer.headers || {}) });
      const send = data => res.write(`data: ${JSON.stringify({ id: `chat-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', ...data })}\n\n`);
      send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      if (answer.call) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: answer.call.name, arguments: JSON.stringify(answer.call.args) } }] }, finish_reason: null }] });
      if (answer.text) send({ choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: answer.call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } } });
      res.end('data: [DONE]\n\n');
    } catch (e) { res.destroy(e); }
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise(res => server.close(res)));
  const config = { ...defaults, effort: 'off', debug: false, model: 'fixture/test', retries: 1, customProviders: [{ id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, keyless: true, models: [{ id: 'test', contextWindow: 128000, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0 } }] }] };
  const session = await Session.create(root, join(root, 'home'));
  const events = [];
  const app = new App(config, session, { home: join(root, 'home'), onEvent: e => events.push(e) });
  t.after(() => app.close());
  return { root, config, session, app, requests, requestHeaders, events, server };
}
