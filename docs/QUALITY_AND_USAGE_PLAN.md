# Quality and inference-usage plan

The measured starting point is [the paired medium-effort benchmark](CODEX_USAGE_COMPARISON.md): Psi 0.2.15 used 17.30 estimated credits versus Codex's 12.24, with 65 versus 40 model requests and 81.4% versus 88.2% input cache hits. Both fully passed 3/6 cells. This small native pilot does not establish long-loop performance.

The target is **at least 40% fewer estimated Standard credits than Codex at equal or better quality**, with no additional failed tasks. On the recorded workload that means at most 7.34 credits, a 57.6% reduction from Psi's measured baseline. This is a promotion target, not an achieved saving. Lowering reasoning, changing the model or suppressing the requested final review would invalidate the requested medium-versus-medium comparison.

## Already implemented after that measurement

- Successful `finish` calls publish a full evidence-backed Markdown report directly. The usual path requires no extra model request. Legacy calls without a report get a bounded text-only review request; a provider failure produces an explicit limited receipt rather than invented findings.
- Plan mode continues after recording progress so the user receives the actual plan. Progress updates belong beside useful tool calls, with detail in the final review.
- Final reports are journaled for restore and export without injecting another duplicate assistant message into the inference context. A saved unpublished report can be recovered without inference.
- UI usage refreshes and session cleanup use no inference. No measured benchmark cell was rerun after these changes, and no efficiency gain is claimed for them.

## 1. Reduce avoidable model round trips

Instrument request purpose, prompt size, tool-result size, cache misses, retry count and report generation separately. The six measured Psi runs made 15 `progress`, six naming, seven checkpoint and six finish calls, but these tool counts are not themselves separate request counts. Identify standalone housekeeping turns before changing behavior.

Move chat naming and routine progress/checkpoint metadata onto useful responses, or deterministic local state where possible. Avoid standalone requests for narration. Support a deliberate independent-read group, keep dependent edits ordered and let a model execute a complete build/verification command in one durable job. Do not retry or poll model-side for known job IDs. Initial target: no more model requests than Codex on paired successful tasks.

## 2. Improve stable-context caching

Record the exact serialized stable-prefix hash per request. Audit dynamic system-prompt sections, session settings changes, model routes and tool schemas for avoidable cache invalidation. Keep static instructions and tool definitions stable; place compact changing state later. Preserve provider reasoning signatures correctly and never strip required tool-call/result relationships.

Compare cache-hit rates across both fresh and resumed sessions. A 90% input cache-hit target is useful for diagnosis, but total weighted usage and task outcomes remain the promotion criteria. A large cached prompt can still waste tokens and time.

## 3. Acquire better evidence with less context

Search before reading, return relevant line ranges, and prefer structured command/test summaries to full repeated logs. Give repeated unchanged artifacts content hashes and retain full evidence locally. Bound worker reports to conclusions, exact file/evidence references and unresolved risks. Avoid regenerating repository summaries when source identities match.

Add source-aware final-review checks: cite actual files/URLs, match commands to recorded outcomes, distinguish observed behavior from proposed causes, retain failed checks, and state version or sample limits. A local check must not invent verification or rewrite model conclusions. Detailed reviews should summarize the evidence already gathered, not launch redundant research.

## 4. Fix benchmark correctness failures before chasing a token score

Investigate configuration task 010 and cleaning task 028 against their contracts, preserving their failures. Add unseen tasks covering configuration, data parsing, repository repair and long-running job recovery. Keep graders hidden from model workspaces. Improvement work may inspect development tasks, but evaluation must use preselected held-out tasks and unchanged graders.

For Battlecode, separate build/correctness checks, replay fidelity, local comparative outcomes and live competition results. Keep source/WASM identities, paired maps/seeds/sides and fresh confirmation fixtures. A cheaper loop that promotes an invalid bot is a failure.

## 5. Keep delegation selective

OVERKILL is off in the requested comparison. Measure OVERKILL separately: spawn only concrete independent assignments, give unique short task names and disjoint ownership, enforce inherited scope and aggregate worker usage exactly once. Compare quality-adjusted cost with the single-agent baseline before claiming that extra workers save usage.

## Validation and promotion

1. Freeze the current 0.2.15 results as a baseline and record every candidate source/configuration identity.
2. Make one change category at a time and verify it locally before spending inference.
3. Use development tasks to tune; preselect a broader held-out set and run at least three balanced paired trials per task with the same model, medium effort, service tier and account class. Include short tasks, long tasks and resumed sessions.
4. Report all failures, raw token types, estimated credits, wall time and final-review quality. Compare both aggregate and matched-quality subsets, labeling filtered views. Record transient provider errors separately; do not silently discard losing cells.
5. Promote only after at least 40% lower weighted usage, equal or better full-success rate, preserved evidence/review quality and no new scope, recovery or account-routing regressions. Use paired uncertainty intervals; a point estimate from three tasks is insufficient.

Do not infer the exact five-hour or weekly quota formula from token totals. The public credit-rate estimate and rounded provider quota snapshots answer different questions. No further paid/subscription inference is required to write this plan or run local fixture tests.

## Implementation update, 2 November 2026 (0.2.19)

Implemented stable core instructions with append-only runtime state, sorted tool definitions, request-prefix fingerprints and size telemetry, separate compaction instructions/cache identity, retained final-review schemas with tool invocation disabled, concurrent independent file reads, short progress receipts, context-aware unchanged-read reuse and locally awaited jobs. Delegations now require rationale, reject duplicate active prompts and overlapping reserved paths, return compact reports with exact verification receipts, and use a bounded general-worker request limit. Completion evidence is hashed and must be regular files.

Workers now reside within parent sessions; idle legacy workers migrate with intact journals/results, and statistics include nested usage without double counting. These changes were checked with local fixtures and file/process tests. The recorded 0.2.15 benchmark remains unchanged. No paid benchmark was rerun, no percentage of model-usage savings is claimed, and the 40% target remains unproven.
