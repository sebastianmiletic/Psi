# Implemented efficiency and correctness changes

Psi 0.2.19 keeps one user-facing chat per parent task and puts worker journals, results and artifacts beneath it. Workers retain independent model contexts and follow-ups, but do not appear as extra saved sessions. Existing idle workers migrate automatically; active locks and jobs are respected. Usage/statistics include nested workers exactly once.

## Caching

The reusable instruction prefix no longer changes when a chat is named, the plan/execute mode changes or the worker configuration changes. Current runtime state is appended only when it changes. Tool definitions are sorted deterministically. Supported final-review requests keep the same definitions with invocation disabled; compaction uses a separate short prompt/cache identity rather than sending the full working instructions.

This follows OpenAI's guidance to keep instructions/tool definitions stable and append conversation turns. [Official prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching). Provider cache retention and hit rates still depend on the backend; no cache hit is guaranteed by a local fingerprint.

Each request records `request_metrics`: route, purpose, instruction/tool prefix hash, whether that hash changed, instruction/tool/input character counts and message/tool counts. Raw prompts and credentials are not included. Existing provider usage receipts report actual cached input tokens. Character counts and hashes are diagnostics, not token billing measurements.

A local serialization comparison with an empty example workspace, Battlecode profile and OVERKILL off found 6,398 previous system-prompt characters versus 4,013 core characters plus 1,143 initial runtime-state characters: 19.4% fewer instruction/state characters. This excludes tools and task content. It is not a measured reduction in model tokens, credits or subscription allowance.

## Fewer avoidable round trips and repeated output

- Independent file reads can run together, matching the existing parallel search/fetch path. Guidance asks for these in one response.
- Routine title refinement is optional and batched with useful work. Progress is reserved for substantive plan changes; its receipt contains the percent and evidence path rather than echoing the complete plan.
- Repeated file/range reads recheck current content, then return a short reference only when the earlier complete result is still in model context. Changed content, missing earlier results and compaction force fresh content. Images and truncated reads are excluded. The small in-memory cache is bounded to 32 entries.
- Shell/build calls wait up to five seconds before returning background work. `job wait` with no explicit interval awaits completion locally, while explicit `wait_ms` preserves bounded waits. Cancellation remains available.
- Full final reviews remain automatic. Supplying `finish.report` still avoids a second request; no requested evidence or review detail is removed to achieve a lower counter.

## Delegation and correctness

Every model-directed spawn needs a brief rationale, concrete prompt and unique task name. Active duplicate assignments are rejected even with a different name. Optional file reservations reject overlapping execution assignments, including overlapping directories. Reservations coordinate workers; inherited workspace isolation remains the access boundary.

A general worker without a preset has a 32-request limit. Existing per-preset model, effort, mode and limits remain configurable. Plan-mode parents force read-only workers. Worker lists omit full prompts and summaries; status and delivered summaries are bounded, with the full result path retained for inspection. Creation and follow-up admission share a queue to respect concurrency limits.

Optional `checks` are exact command strings. Worker result files record observed commands, job states, exit codes, failed commands and requested checks that were not verified. A check counts as verified only after an exact matching command completes with exit code zero; descriptive claims or still-running jobs do not qualify. A receipt does not establish the task's overall correctness by itself: the parent must review evidence and limitations.

`finish` now records hashes, sizes and modification times of actual regular evidence files. Missing files, directories and files changing during verification are rejected. Worker reports still pass through the existing review-before-finish gate. No competitive Battlecode result is inferred from local checks.

## Validation limits

Local fixtures exercise serialized requests, file mutation, concurrency, real worker subprocesses, migrations and accounting. No paid inference was used for these changes. The previous paired benchmark remains the baseline: Psi used more usage than Codex in that pilot. Real-world savings and the plan's 40% improvement target require a later matched benchmark and are not claimed here.
