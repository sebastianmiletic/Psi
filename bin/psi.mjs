#!/usr/bin/env node
import { version,updateInstallation,checkUpdate } from '../src/updates.mjs';
import { importPi } from '../src/pi-import.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { stat, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, saveConfig, psiHome, cleanTerminal, redact } from '../src/storage.mjs';
import { Session } from '../src/session.mjs';
import { App } from '../src/app.mjs';
import { migrateWorkers } from '../src/worker-storage.mjs';

const help = `Ψ  Psi ${version}

Usage: psi [options] [prompt]
       psi models [filter]
       psi providers [filter]
       psi accounts list|use <id>|remove <id>
       psi accounts add --provider <id> --name <label> --key-env <ENV_VAR>
       psi provider add --id <id> --url <base-url> --model <id> [--keyless]
       psi sessions
       psi jobs [id] | psi jobs stop <id>
       psi bench <manifest.json>
       psi update [--check]
       psi accounts import-pi --account <name> [--account <name>]
       psi doctor

  -C, --cwd <path>           Workspace (default: current directory)
  -p, --print <prompt>       Run once without the terminal UI
  -m, --model <provider/id>  Model for this session
      --effort <level>      Reasoning effort
      --budget <dollars>    Estimated session cost ceiling; 0 = unlimited
      --max-steps <count>   Requests per run; 0 = unlimited
      --tokens <count>      Maximum output tokens per request
      --loop <objective>    Persist until completion or user stop
      --mode <plan|execute> Read-only planning or execution
      --overkill            Enable configured subagent workflow
      --resume <id>         Resume a saved session
      --continue           Resume the latest session in this workspace
      --profile <name>      battlecode (default) or general
      --json                Emit JSONL events in print mode
      --no-debug            Disable operational debug logs
  -h, --help                Show help
  -v, --version             Show version

Interactive: /model /effort /accounts /directory /settings /subagents /loop /name /help
Shift+Tab: plan/execute. Escape twice: stop. Enter while busy: queue.
Tools stay within approved directories, without approval prompts.
Settings and credentials: PSI_HOME (default ~/.psi)
`;
try {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, cwd: { type: 'string', short: 'C' },
    print: { type: 'string', short: 'p' }, model: { type: 'string', short: 'm' }, effort: { type: 'string' }, budget: { type: 'string' },
    'max-steps': { type: 'string' }, tokens: { type: 'string' }, loop: { type: 'string' }, resume: { type: 'string' }, continue: { type: 'boolean' },
    mode:{type:'string'},overkill:{type:'boolean'},check:{type:'boolean'},account:{type:'string',multiple:true},'pi-file':{type:'string'},
    profile: { type: 'string' }, json: { type: 'boolean' }, 'no-debug': { type: 'boolean' },
    provider: { type: 'string' }, name: { type: 'string' }, 'key-env': { type: 'string' }, id: { type: 'string' }, url: { type: 'string' }, api: { type: 'string' }, keyless: { type: 'boolean' },
  } });
  if (v.help) { console.log(help); process.exit(0); }
  if (v.version) { console.log('Ψ Psi '+version); process.exit(0); }
  const home = psiHome(); const config = await loadConfig(home);
  if(positionals[0]==='update'){console.log(v.check?JSON.stringify(await checkUpdate(home,{force:true}),null,2):(await updateInstallation(home)).message);process.exit(0);}
  if(v.mode){if(!['plan','execute'].includes(v.mode))throw new Error('Use --mode plan or --mode execute.');config.agentMode=v.mode;}if(v.overkill)config.overkill=true;
  await migrateWorkers(home);
  for (const [flag, setting] of [['budget', 'budget'], ['max-steps', 'maxSteps'], ['tokens', 'maxOutputTokens']]) {
    if (v[flag] !== undefined) {
      const n = Number(v[flag]);
      if (!Number.isFinite(n) || n < 0 || (flag !== 'budget' && !Number.isInteger(n)) || (flag === 'tokens' && n < 256)) throw new Error(`Invalid --${flag}`);
      config[setting] = n;
    }
  }
  for (const key of ['model', 'effort', 'profile']) if (v[key]) config[key] = v[key];
  if (!['battlecode', 'general'].includes(config.profile)) throw new Error('Profile must be battlecode or general.');
  if (v['no-debug']) config.debug = false;
  const cwd = resolve(v.cwd || process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace is not a directory.');
  const command = positionals[0];
  if (command === 'bench') {
    if (!positionals[1]) throw new Error('Usage: psi bench <manifest.json>');
    const { readFile } = await import('node:fs/promises'); const { runSweep } = await import('../src/sweep.mjs');
    const controller = new AbortController(); process.on('SIGINT', () => controller.abort(new Error('Benchmark interrupted.'))); process.on('SIGTERM', () => controller.abort(new Error('Benchmark terminated.')));
    const result = await runSweep(JSON.parse(await readFile(resolve(cwd, positionals[1]), 'utf8')), { cwd, signal: controller.signal, onProgress: e => { if (!v.json) console.error(`${e.completed} recorded · ${e.candidate} · ${e.status}`); } });
    console.log(JSON.stringify(result, null, 2)); process.exit(result.changedArtifacts.length || Object.values(result.candidates).some(c => c.errors) ? 1 : 0);
  }
  const administrative = ['models', 'providers', 'accounts', 'provider', 'sessions', 'jobs', 'doctor'].includes(command);
  let session;
  if (!administrative) {
    if (v.resume) session = await Session.load(v.resume, home);
    else if (v.continue) { const latest = (await Session.list(home)).find(s => s.cwd === cwd); session = latest ? await Session.load(latest.id, home) : await Session.create(cwd, home); }
    else session = await Session.create(cwd, home);
    // Explicit invocation flags override saved session settings.
    if(v.mode)session.state.settings={...session.state.settings,agentMode:v.mode};if(v.overkill)session.state.settings={...session.state.settings,overkill:true};
    for (const [flag, key] of [['model', 'model'], ['effort', 'effort'], ['budget', 'budget'], ['max-steps', 'maxSteps'], ['tokens', 'maxOutputTokens'], ['profile', 'profile']]) if (v[flag] !== undefined) session.state.settings = { ...session.state.settings, [key]: config[key] };
  } else session = { home,dir:join(home,'administration'),meta: { id: 'administration', cwd }, state: {} };
  let outputOpen = false;
  const app = new App(config, session, { home, onEvent: event => {
    if (v.json) console.log(JSON.stringify(event));
    else if (event.type === 'text_delta' && !event.summary) { process.stdout.write(cleanTerminal(event.delta)); outputOpen = true; }
    else if (event.type === 'final_response') { if (outputOpen) process.stdout.write('\n'); console.log(cleanTerminal(event.text)); outputOpen = false; }
    else if (event.type === 'tool_start') { if (outputOpen) process.stdout.write('\n'); outputOpen = false; console.error(`  ${event.call.name} ${cleanTerminal(String(event.call.arguments.command || event.call.arguments.path || event.call.arguments.url || '')).slice(0, 140)}`); }
    else if (['retry', 'stopped'].includes(event.type)) console.error(redact(event.error || 'Stopped.'));
  } });
  if (command === 'models') {
    const q = positionals.slice(1).join(' ').toLowerCase();
    const models = app.registry.all().filter(m => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q));
    console.log(v.json ? JSON.stringify(models) : models.map(m => `${m.provider}/${m.id}  ${Math.round(m.contextWindow / 1000)}k  $${m.cost.input}/$${m.cost.output} per 1M`).join('\n')); process.exit(0);
  }
  if (command === 'providers') {
    const q = positionals.slice(1).join(' ').toLowerCase(); const providers = app.registry.models.getProviders().filter(p => `${p.id} ${p.name}`.toLowerCase().includes(q)).map(p => ({ id: p.id, name: p.name, models: p.getModels().length, oauth: !!p.auth.oauth }));
    console.log(v.json ? JSON.stringify(providers) : providers.map(p => `${p.id.padEnd(28)} ${p.name}  ${p.models} models${p.oauth ? '  sign-in' : ''}`).join('\n')); process.exit(0);
  }
  if (command === 'accounts') {
    const action = positionals[1] || 'list';
    if(action==='import-pi'){const imported=await importPi(app.registry.accounts,v['pi-file']||join(homedir(),'.pi/agent/pi-accounts.json'),v.account);console.log(JSON.stringify(imported,null,2));}
    else if (action === 'list') { const list = await app.registry.accounts.list(); console.log(v.json ? JSON.stringify(list) : list.map(a => `${a.active ? '✓' : ' '} ${a.provider} · ${a.name} (${a.type})  ${a.id}`).join('\n') || 'No saved accounts. Run psi and use /accounts.'); }
    else if (action === 'use' || action === 'remove') { if (!positionals[2]) throw new Error('Account ID required.'); const provider = await app.registry.accounts[action](positionals[2]); if (provider) { const m = app.registry.models.getModels(provider)[0]; if (m) await saveConfig({ model: `${provider}/${m.id}` }, home); } console.log(action === 'use' ? 'Account switched.' : 'Account removed.'); }
    else if (action === 'add') {
      if (!v.provider || !v.name || !v['key-env']) throw new Error('Use --provider, --name and --key-env.');
      if (!app.registry.models.getProvider(v.provider)) throw new Error('Unknown provider.');
      const key = process.env[v['key-env']]; if (!key) throw new Error(`Environment variable ${v['key-env']} is empty.`);
      await app.registry.accounts.add(v.provider, v.name, { type: 'api_key', key }); console.log('Account added.');
    } else throw new Error('Unknown accounts action. See psi --help.');
    process.exit(0);
  }
  if (command === 'provider') {
    if (positionals[1] !== 'add' || !v.id || !v.url || !v.model) throw new Error('Usage: psi provider add --id <id> --url <base-url> --model <id> [--keyless]');
    const p = { id: v.id, name: v.name || v.id, baseUrl: v.url, api: v.api || 'openai-completions', keyless: !!v.keyless, models: [{ id: v.model, contextWindow: 128000 }] };
    app.registry.register(p); await saveConfig({ customProviders: [...config.customProviders.filter(x => x.id !== p.id), p] }, home); console.log(`Provider added: ${p.id}`); process.exit(0);
  }
  if (command === 'sessions') { const list = await Session.list(home); console.log(v.json ? JSON.stringify(list) : list.map(s => `${s.id}  ${s.title}\n  ${s.cwd}`).join('\n')); process.exit(0); }
  if (command === 'jobs') {
    if (positionals[1] === 'stop') { if (!positionals[2]) throw new Error('Job ID required.'); console.log(JSON.stringify(await app.jobs.stop(positionals[2]), null, 2)); }
    else if (positionals[1]) console.log(JSON.stringify(await app.jobs.get(positionals[1]), null, 2) + '\n' + await app.jobs.tail(positionals[1]));
    else console.log(JSON.stringify(await app.jobs.list(), null, 2)); process.exit(0);
  }
  if (command === 'doctor') {
    const candidates = [process.env.PSI_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/usr/bin/chromium'].filter(Boolean);
    let chrome; for (const path of candidates) if (await access(path).then(() => true, () => false)) { chrome = path; break; }
    const report = { version, node: process.version, home, providers: app.registry.models.getProviders().length, models: app.registry.all().length, catalogDate: app.registry.catalogDate, defaultModel: config.model, accounts: (await app.registry.accounts.list()).map(({ name, provider, type, active }) => ({ name, provider, type, active })), ripgrep: spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0, browser: chrome || 'Set PSI_CHROME_PATH to enable browser', permissions:'approved directories; OS-isolated shell; no approval prompts',shellIsolation:process.platform==='darwin'?'macOS Seatbelt':process.platform==='linux'?'bubblewrap required':'Use WSL2 + bubblewrap for shell tools', debug: config.debug };
    console.log(JSON.stringify(report, null, 2)); process.exit(report.ripgrep ? 0 : 1);
  }
  // Validate model and effort before entering raw terminal mode.
  app.registry.find(app.engine.config.model);
  const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
  if (!getSupportedThinkingLevels(app.engine.model).includes(app.engine.config.effort)) {
    if (v.effort) throw new Error(`Supported efforts: ${getSupportedThinkingLevels(app.engine.model).join(', ')}`);
    app.engine.config.effort = getSupportedThinkingLevels(app.engine.model).includes('medium') ? 'medium' : getSupportedThinkingLevels(app.engine.model)[0];
  }
  const prompt = v.print || v.loop || positionals.join(' ');
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; app.engine.stop(); });
  process.on('SIGTERM', () => { interrupted = true; app.engine.stop(); void app.close(); });
  if (v.print !== undefined || v.json || (!process.stdin.isTTY && prompt)) {
    if (!prompt && !v.resume && !v.continue) throw new Error('A prompt is required in print mode.');
    try { await app.engine.run(prompt || 'Continue the pending task.', { loop: !!v.loop }); }
    finally { if (outputOpen) process.stdout.write('\n'); await app.close(); }
    if (interrupted) process.exitCode = 130;
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use -p <prompt> for non-interactive input.');
    // The interactive UI owns stdout while active.
    app.options.onEvent = v.json ? app.options.onEvent : undefined;
    await app.startUI();
    if (prompt) { app.ui.user(prompt); void app.engine.run(prompt, { loop: !!v.loop }).catch(() => {}); }
  }
} catch (e) {
  console.error(`Psi: ${redact(e.message)}`); process.exitCode = 1;
}
