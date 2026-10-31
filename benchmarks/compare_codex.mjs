#!/usr/bin/env node
// Paired native Harness-Bench runs. Private auth/traces stay in gitignored artifacts.
import { readFile, writeFile, mkdir, cp, readdir, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Accounts } from '../src/accounts.mjs';
import { Registry } from '../src/providers.mjs';
import { QuotaMonitor } from '../src/quota.mjs';
import { atomicJSON, loadConfig } from '../src/storage.mjs';
import { run, version } from '../src/updates.mjs';

export function normalizedUsage(arm, events) {
  if (arm === 'psi') {
    const rows = events.filter(e => e.type === 'usage' && e.usage);
    if (!rows.length) return null;
    const sum = key => rows.reduce((n, e) => n + (e.usage[key] || 0), 0);
    return { uncachedInput: sum('input'), cachedInput: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'), reasoning: sum('reasoning'), requests: rows.length, total: sum('input') + sum('cacheRead') + sum('cacheWrite') + sum('output') };
  }
  const rows = events.filter(e => e.type === 'turn.completed' && e.usage);
  if (!rows.length) return null;
  const sum = key => rows.reduce((n, e) => n + (e.usage[key] || 0), 0);
  const input = sum('input_tokens'), cached = sum('cached_input_tokens'), output = sum('output_tokens');
  return { uncachedInput: input - cached, cachedInput: cached, cacheWrite: 0, output, reasoning: sum('reasoning_output_tokens'), requests: null, total: input + output };
}
const jsonLines = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
async function files(path) {
  const rows = [];
  for (const e of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const p = join(path, e.name);
    if (e.isDirectory()) rows.push(...await files(p)); else rows.push(p);
  }
  return rows;
}
async function execute(command, args, cwd, env, dir, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      try {
        await writeFile(join(dir, 'events.jsonl'), stdout, { mode: 0o600 });
        await writeFile(join(dir, 'stderr.log'), stderr, { mode: 0o600 });
        resolveRun({ code, signal, timedOut, events: jsonLines(stdout) });
      } catch (e) { reject(e); }
    });
  });
}
async function main() {
  const { values: v } = parseArgs({ options: { out: { type: 'string' }, suite: { type: 'string' }, trials: { type: 'string', default: '2' }, task: { type: 'string', multiple: true }, model: { type: 'string' }, profile: { type: 'string' } } });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const suite = resolve(v.suite || join(homedir(), '.cache/psi/harness-bench'));
  const out = resolve(v.out || join(root, 'benchmarks/artifacts', new Date().toISOString().replaceAll(':', '-') + '-codex-comparison'));
  await mkdir(out, { recursive: true, mode: 0o700 });
  const workRoot = await mkdtemp(join(tmpdir(), 'psi-codex-usage-'));
  const config = await loadConfig(), accounts = new Accounts(), account = await accounts.selected('openai-codex');
  const credential = await accounts.store(account).read('openai-codex');
  const codexAuth = JSON.parse(await readFile(join(homedir(), '.codex/auth.json'), 'utf8'));
  if (!credential?.access || !codexAuth.tokens?.account_id || codexAuth.tokens.account_id !== credential.accountId) throw new Error('The current Psi and Codex accounts must match.');
  const route = v.model ? (v.model.startsWith('openai-codex/') ? v.model : 'openai-codex/' + v.model) : config.model;
  if (!route.startsWith('openai-codex/')) throw new Error('Select a Codex model in Psi for a matched comparison.');
  const model = route.slice('openai-codex/'.length), names = await readdir(join(suite, 'tasks'));
  const tasks = (v.task || ['009', '010', '028']).map(id => names.find(n => n === id || n.startsWith(id + '-')));
  if (tasks.some(t => !t)) throw new Error('Unknown task.');
  const trials = Number(v.trials); if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error('Use 1 to 10 trials.');
  const grader = join(suite, '.venv/bin/python'), python = '/opt/homebrew/opt/python@3.12/bin/python3.12';
  const base = { ...config, profile: v.profile || config.profile, model: 'openai-codex/' + model, effort: 'medium', overkill: false, autoSwitchAccounts: false, checkForUpdates: false, autoUpdate: false, debug: false, maxSteps: 80, budget: 0, retries: 2, python };
  const summary = {
    startedAt: new Date().toISOString(), benchmark: 'Qihoo360/harness-bench', sourceCommit: (await run('git', ['rev-parse', 'HEAD'], suite)).trim(),
    psiCommit: (await run('git', ['rev-parse', 'HEAD'], root)).trim(), psiVersion: version, codexVersion: (await run('codex', ['--version'], root)).trim(),
    model, effort: 'medium', overkill: false, subagents: false, sameAccount: true, psiProfile: base.profile, trialsPerTask: trials, tasks,
    protocol: 'Native macOS copied workspaces, original unchanged outcome oracles, independent sessions, no personal configs/MCP for Codex, balanced arm order across two rounds. Not the full Docker/ABI benchmark. Native prompts/tools differ by design. Psi retains its configured Battlecode/general profile and an 80-request guard; both arms have a 480-second timeout per cell. No model-directed retries of failed scored cells.',
    usageDefinition: 'Total = uncached input + cached input + cache write + output. Reasoning is already included in output. Codex input_tokens includes its cached_input_tokens; Psi input excludes cacheRead. Token totals are not a subscription-quota formula or an API bill.',
    results: []
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CODEX_|^PSI_|(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)$/.test(k)));
  for (let trial = 1; trial <= trials; trial++) for (let ti = 0; ti < tasks.length; ti++) {
    const task = tasks[ti], arms = (trial + ti) % 2 ? ['psi', 'codex'] : ['codex', 'psi'];
    for (const arm of arms) {
      const id = `trial-${trial}-${task}-${arm}`, dir = join(out, id), workspace = join(workRoot, id), psiHome = join(dir, 'psi-home'), codexHome = join(dir, 'codex-home');
      await mkdir(dir, { recursive: true, mode: 0o700 }); await cp(join(suite, 'tasks', task, 'workspace'), workspace, { recursive: true, force: false, errorOnExist: true });
      const prompt = (await readFile(join(suite, 'tasks', task, 'instruction.md'), 'utf8')).replaceAll('$WORKSPACE', workspace) + '\n\nWork only in this workspace. Do not access the benchmark source, hidden tests, reference solutions or graders. Complete the requested artifacts and report actual verification and limitations. Do not delegate to subagents. Python is available at ' + python + '.';
      await writeFile(join(dir, 'prompt.txt'), prompt, { mode: 0o600 });
      const isolated = new Accounts(psiHome); await isolated.add('openai-codex', account.name, structuredClone(credential)); await atomicJSON(join(psiHome, 'config.json'), base);
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      await atomicJSON(join(codexHome, 'auth.json'), { ...codexAuth, tokens: { ...codexAuth.tokens, access_token: credential.access, refresh_token: credential.refresh } });
      await cp(join(homedir(), '.codex/models_cache.json'), join(codexHome, 'models_cache.json')).catch(() => {});
      const registry = new Registry(base, psiHome), pinned = await isolated.selected('openai-codex'), quota = new QuotaMonitor(registry, base, psiHome);
      const snapshot = async () => { const usage = await quota.refresh(pinned, { force: true }); return { at: new Date().toISOString(), limits: usage.limits, error: usage.quotaError || null }; };
      const before = await snapshot();
      console.log(`START ${id}`); await atomicJSON(join(out, 'progress.json'), { id, startedAt: new Date().toISOString(), completed: summary.results.length, planned: trials * tasks.length * 2, workspace });
      const start = Date.now(); let execution;
      try {
        const args = arm === 'psi' ? [join(root, 'bin/psi.mjs'), '-C', workspace, '--effort', 'medium', '--model', base.model, '--mode', 'execute', '--json', '--no-debug', '-p', prompt] : ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-C', workspace, '-m', model, '-s', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="medium"', '-c', 'service_tier="default"', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', '--json', prompt];
        await atomicJSON(join(dir, 'invocation.json'), { arm, command: arm === 'psi' ? process.execPath : 'codex', args, cwd: workspace, effort: 'medium', overkill: false });
        execution = await execute(arm === 'psi' ? process.execPath : 'codex', args, workspace, { ...env, PSI_HOME: psiHome, CODEX_HOME: codexHome }, dir, 480000);
        const wallSeconds = (Date.now() - start) / 1000, after = await snapshot();
        const usage = normalizedUsage(arm, execution.events);
        if (arm === 'codex' && usage) {
          const rollouts = (await files(join(codexHome, 'sessions'))).filter(p => p.endsWith('.jsonl'));
          let count = 0, previous = 0;
          for (const path of rollouts) for (const e of jsonLines(await readFile(path, 'utf8'))) {
            if (e.type === 'event_msg' && e.payload?.type === 'token_count') {
              const total = e.payload.info?.total_token_usage?.total_tokens;
              if (total > previous) { count++; previous = total; }
            }
          }
          usage.requests = count || null;
        }
        const gradePath = join(dir, 'grade.json');
        await run(grader, [join(root, 'benchmarks/score_harness_bench.py'), suite, task, workspace, gradePath], root);
        const grade = JSON.parse(await readFile(gradePath, 'utf8'));
        const result = { task, trial, arm, exitCode: execution.code, signal: execution.signal, timedOut: execution.timedOut, wallSeconds, usage, outcomeScore: grade.outcome_score, taskSuccess: grade.task_success, checks: grade.checks, gradeSha256: createHash('sha256').update(await readFile(gradePath)).digest('hex'), quotaBefore: before, quotaAfter: after, subagentsStarted: execution.events.filter(e => e.type === 'agent_started').length };
        summary.results.push(result); await cp(workspace, join(dir, 'workspace'), { recursive: true });
        await atomicJSON(join(out, 'summary.json'), { ...summary, updatedAt: new Date().toISOString() });
        console.log(`DONE ${id}: score=${result.outcomeScore} tokens=${usage?.total ?? 'unavailable'} requests=${usage?.requests ?? '?'} seconds=${wallSeconds.toFixed(1)}`);
        if (!usage || execution.events.some(e => /quota|rate limit|usage limit/i.test(e.error?.message || (typeof e.error === 'string' ? e.error : '') || e.message || '') && ['error', 'turn.failed'].includes(e.type))) throw new Error('Usage unavailable or account limit reached; partial results retained.');
      } finally {
        await rm(join(codexHome, 'auth.json'), { force: true }); await rm(join(psiHome, 'accounts.json'), { force: true });
      }
    }
  }
  await atomicJSON(join(out, 'summary.json'), { ...summary, completedAt: new Date().toISOString() });
  console.log(`COMPLETE ${join(out, 'summary.json')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
