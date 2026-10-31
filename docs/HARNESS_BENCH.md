# Harness-Bench: Psi 0.2.0 smoke evaluation

Run on 31 October 2026 using the original [Qihoo360/Harness-Bench](https://github.com/Qihoo360/harness-bench) tasks and unchanged deterministic outcome oracles at commit `b8d89634c6f445fcc68ceb6744a59bef6cdf4863`.

This is a **three-task native macOS smoke subset**, one trial per task. It is not the standard Docker/ABI evaluation, a full-suite score, a baseline comparison or a leaderboard submission. Docker was not running on the host. The tasks were selected before execution: 009, 010 and 028. No failed task was dropped or selectively rerun in the measured set.

Psi source: `209f50df8bd33b9f1b730f2438cc60b53f4f0c4f`, version 0.2.0. Model: `openai-codex/gpt-5.6-sol`, medium thinking, 8,192 output tokens per request, 80-request ceiling per task. OVERKILL was off. The agent ran within isolated workspace copies; benchmark source, reference solutions and hidden oracles were not granted to the agent. The grading process ran separately afterwards.

| Task | Outcome score | Success | Requests | Seconds |
| --- | ---: | --- | ---: | ---: |
| 009: safe archive extraction | 1.00 | Yes | 17 | 68.0 |
| 010: layered configuration resolution | 0.00 | No | 17 | 71.0 |
| 028: spreadsheet-style data cleaning | 1.00 | Yes | 10 | 54.0 |

Mean outcome score: **0.667**, with **2/3 tasks successful**. Recorded wall time total: **193.0 seconds**. Usage: **87,803 uncached input tokens**, **475,904 cache-read tokens**, **16,413 output tokens**, 44 requests. Catalog accounting total: **$0.8698**; this used a subscription account and is not an actual API charge or invoice.

Task 010 produced the required artifacts and preserved the input/workspace gates, but failed the original oracle's pure-function import audit and handoff requirements. Its public tests alone did not establish success. The recorded score is retained as zero. Neither its source nor grader was altered to obtain a pass.

An earlier preflight run found no `python` alias and zsh heredoc temporary files being denied outside private scratch. That run was stopped before grading and retained separately. Psi then added a scratch-scoped Python alias and `TMPPREFIX`; the measured run restarted **all three tasks** in clean workspaces. This environmental repair is not a selectively retried benchmark cell.

The [sanitized result summary](harness-bench-results.json) records the source/model configuration, checks and grade hashes. Raw artifacts remain locally under `benchmarks/artifacts/2026-10-31-native-v2/`, excluded from Git because they contain private session/account state. No credentials or raw model traces are published.

Reproduce after cloning the upstream benchmark and installing its Python dependencies:

```sh
node benchmarks/run_harness_bench.mjs \
  --suite /path/to/harness-bench \
  --python /path/to/python3.12 \
  --account "Your saved Pi Codex account" \
  --out benchmarks/artifacts/your-run
```

Omit `--account` to use an explicitly configured environment/API credential instead. The runner creates separate temporary Psi homes, limits each task to ten minutes, uses real inference and invokes the original `score_task_workspace` entry point. It does not provide reference solutions to Psi. These three trials diagnose basic operation; more trials, a comparison arm and the full prescribed environment are needed for reliable performance claims.
