# Psi versus Codex: medium-effort usage

Measured on 31 October 2026: **Psi used 19.8% more total tokens and 41.4% more estimated Standard-speed credits** over this pilot. Both fully passed **3/6 runs**; mean outcome scores were **0.698 for Psi** and **0.665 for Codex**. On the five pairs with identical scores, Psi used **8.6% more total tokens** and **36.1% more estimated credits**.

This is a three-task native macOS pilot with two fresh trials per task and harness, not a full Harness-Bench score, long-running Battlecode test, or universal efficiency ranking. No runtime optimization was made between measured cells.

## Configuration

- Model: **gpt-6.1-sol**, medium reasoning for both; Psi **OVERKILL off**, Codex multi-agent features disabled, no task delegation.
- Psi 0.2.15, source `922b074118fe98806b4068cce537739e321bed7c`; codex-cli 0.165.0.
- Same saved subscription account, authenticated in private independent homes. Original accounts, selections and settings were not changed. Temporary auth copies were removed after each cell.
- Psi retained its configured **battlecode** profile and native prompt/tools, including normal chat naming and progress tools. Codex used its native exec prompt/tools with personal configuration, rules, skills/MCP homes and account switching excluded. This measures the configured Psi engine against a clean Codex CLI, not the richer desktop app.
- Fresh copied workspaces and sessions. Identical task instructions except workspace paths, plus a shared local-only/no-grader/no-subagent instruction and Python path. Default native tool/output behavior was retained. Psi had an 80-request guard, two provider retries and 8,192 maximum output tokens per request; both arms had an eight-minute timeout. No cell reached either guard.
- Original [Qihoo360/Harness-Bench](https://github.com/Qihoo360/harness-bench) tasks 009, 010 and 028 and unchanged original graders at `b8d89634c6f445fcc68ceb6744a59bef6cdf4863`. The grader ran only after a cell ended and its feedback was not sent to the agents. All failed/partial cells are retained; the two trials were planned before execution.
- First-round arm order: Psi/Codex for 009, Codex/Psi for 010, Psi/Codex for 028. The second round reverses each pair. No cold-cache guarantee or deterministic model seed.

## Aggregate results

| Metric, six runs per tool | Psi | Codex | Psi difference |
| --- | ---: | ---: | ---: |
| Total tokens, including cached input | 923,316 | 770,399 | +19.8% |
| Uncached input | 166,016 | 87,797 | +89.1% |
| Cached input | 728,576 | 657,792 | +10.8% |
| Output, including reasoning | 28,724 | 24,810 | +15.8% |
| Input cache hit rate | 81.4% | 88.2% | |
| Model requests | 65 | 40 | +62.5% |
| Estimated Standard credits | 17.30 | 12.24 | +41.4% |
| Agent wall time, excluding grading/quota snapshots | 9.31 min | 7.22 min | +28.9% |
| Fully successful runs | 3/6 | 3/6 | |
| Mean oracle score | 0.698 | 0.665 | |

Psi made more model requests and used more uncached input. Its normal tool calls included `session_title` 6 times and `progress` 15 times; their usage is included, not subtracted. These observations identify optimization candidates, but this test does not isolate a causal contribution for individual tools or instructions. The terminal's lightweight implementation does not establish lower inference usage.

## Every measured pair

| Task | Trial | Psi score | Codex score | Psi total tokens | Codex total tokens | Psi estimated credits | Codex estimated credits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 009 | 1 | 1.00 | 1.00 | 154,730 | 152,206 | 3.09 | 2.30 |
| 010 | 1 | 0.20 | 0.20 | 235,212 | 171,905 | 3.55 | 2.27 |
| 028 | 1 | 0.79 | 0.79 | 71,893 | 78,953 | 2.07 | 1.85 |
| 009 | 2 | 1.00 | 1.00 | 126,451 | 133,732 | 2.33 | 1.87 |
| 010 | 2 | 0.20 | 0.00 | 255,349 | 155,572 | 4.18 | 2.59 |
| 028 | 2 | 1.00 | 1.00 | 79,681 | 78,031 | 2.10 | 1.37 |

Task 009 is archive-extraction preflight repair, 010 is layered configuration repair, and 028 is CSV/data cleaning. Scores range from 0 to 1. Partial credit is not full success. Psi scored higher only on the second 010 trial; all five other paired scores matched.

The five same-score pairs exclude only second-trial 010. Their estimated credits were **13.13 versus 9.65**, a **36.1% increase for Psi**. For the three pairs both tools fully passed, Psi used **0.9% fewer raw tokens**, but **35.7% more estimated credits**, because token types have different rates. These are secondary, explicitly filtered views; the aggregate table retains all twelve cells.

## What usage means

Provider-reported usage receipts are normalized: Psi's input counter excludes cache-read tokens, while Codex's `input_tokens` includes `cached_input_tokens`. Total tokens count uncached input, cached input and output once. Reasoning is a subset of output and is not added again. Codex JSON turn usage is documented in [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). Request counts are Psi usage receipts and increasing Codex token-count receipts from saved rollouts.

Estimated credits use OpenAI's [published Standard rates](https://learn.chatgpt.com/docs/pricing#token-rates), checked 31 October 2026: **50 credits/M uncached input, 2.5 credits/M cached input, 250 credits/M output** for GPT-6.1 Sol. Formula: `(50 × uncached input + 2.5 × cached input + 250 × output) / 1,000,000`. No cache-write tokens occurred. These are estimates at the rate card, not actual deducted credits, USD charges or an exact five-hour/weekly quota measurement. OpenAI states that credit prices alone do not determine included subscription usage.

Private per-cell quota snapshots were retained locally but are not used to attribute consumption: they are rounded, may lag, and can include concurrent activity in this account. No reset credits were consumed and no accounts were switched. This pilot cannot establish a precise subscription-limit savings percentage or predict long-loop performance.

## Evidence and reproduction

[Sanitized receipts, scores, settings and grade hashes](codex-usage-results.json). Raw traces, workspaces, original grades, invocations and private quota snapshots are retained locally under `benchmarks/artifacts/2026-10-31-medium-codex-v1/` and excluded from Git. There were no subagent starts, timeouts or nonzero CLI exits in the measured set. Native scoring differs from the benchmark's prescribed Docker/ABI environment.

With the original suite and its Python dependencies installed in its `.venv`, and matching existing Codex/Psi logins:

```sh
node benchmarks/compare_codex.mjs \
  --suite "$HOME/.cache/psi/harness-bench" \
  --model gpt-6.1-sol --profile battlecode --trials 2 \
  --out benchmarks/artifacts/your-comparison
```

This runner uses real subscription usage. It does not change your selected account, reauthenticate, automatically consume resets or switch to another account. Local Python 3.12 is currently expected at the Homebrew path used in the recorded runs.
