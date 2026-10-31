# Durable Battlecode workflow

The adapter targets the existing Vision workflow in `/Users/sebastianmiletic/Coding/Cambridge Battlecode 2026`. It wraps the project's controllers and uses their platform lock, five-game fixture groups, restoration and collection logic. General projects keep the general tools; the extra Battlecode schemas load only for recognized workspaces under the Battlecode profile.

## Start

```sh
psi -C "/Users/sebastianmiletic/Coding/Cambridge Battlecode 2026"
```

Use `/project` for a read-only baseline/source/controller inspection, `/tools` for the current tool definitions, `/experiments` for saved experiment records, and `/settings` for execution/appearance controls. `/experiments ID` reconciles persisted jobs and receipts. No live operation runs merely by opening Psi or inspecting the project.

Enter `/loop` and describe the objective when prompted. Include the measurable success condition and whether live experimentation is within the requested task. The goal persists through plain responses, provider failures, quota waits and context compaction. Double Escape preserves it; another message or a resumed session continues it. The goal finishes through `finish` with a summary and existing evidence paths. For competitive qualification, supply `experiment_id` so Psi recomputes discovery and fresh confirmation checks before completing.

The following JSON examples are **AI tool arguments**, not terminal slash commands. They illustrate the intended workflow; they were not run against the real platform during harness development.

## 1. Inspect and preselect controls

`battlecode_inspect` verifies the documented Vision baseline, manifest version, exact source file set and hashes. It discovers the own-team ID from the existing controller and locates trial, collector and report scripts. It defaults to the explicit `~/.venvs/cambc400/bin/cambc` executable, adjustable in `/settings`.

The CLI setting controls the adapter's build executable. The existing live scripts retain their own pinned platform CLI; changing the build path does not rewrite those scripts.

A control folder must already contain a complete baseline `receipt.json`, `group.json`, `results.json` and all five replay archives. The adapter verifies baseline version, distinct map/opponent/seat fixtures, finished games, outcomes, engine identity and replay hashes, then freezes these file identities in the experiment.

For a task explicitly requesting live work, `battlecode_control` can create a fresh incumbent control using the existing controller:

```json
{"source_group":"HISTORICAL_GROUP_UUID","maps":["MAP_1","MAP_2","MAP_3","MAP_4","MAP_5"]}
```

This persists its intent and returns an experiment/job ID. Await that job with `job` action `await`, reconcile its status, then call `battlecode_collect` with the returned ID and `stage: "discovery"`. Its output folder can be used as a preselected control. This consumes real competition quota; it does not run for read-only planning.

## 2. Create an isolated experiment

`battlecode_experiment`:

```json
{
  "action":"create",
  "hypothesis":"Improve one measured capture decision without losing any incumbent win",
  "discovery_control":"results/path/to/discovery-control",
  "confirmation_controls":["results/path/to/fresh-confirmation-control"]
}
```

At least one complete confirmation control is required **before** discovery. Opponent/map/seat keys must be disjoint from discovery and from every other confirmation panel. Maps alone do not define freshness; the full paired fixture key is recorded. Fixture coverage is finite and does not prove broad future ranked performance.

Without `candidate`, Psi copies the baseline's `src` into its own experiment directory. An optional candidate path must be separate from the incumbent and belong to no prior experiment. The returned record contains a unique marker. Add that marker to code which actually prints it at startup; putting it only in a comment will fail replay verification later.

`battlecode_freeze` with `{"id":"EXPERIMENT_ID"}` freezes the exact source files. A tested candidate cannot be re-frozen: create another experiment for another variant. Source symlinks are refused.

## 3. Build and check correctness

`battlecode_correctness` with `{"id":"EXPERIMENT_ID"}` starts one durable job:

1. The pinned CLI builds the isolated candidate in release mode.
2. Configured correctness argv commands run, or the project's `check_observation.py` is used when present.
3. The worker checks source identity before and after, records the injected WASM hash and commits a result artifact.

For example, `battlecodeChecks` in `~/.psi/config.json` can contain argv arrays such as `[["python3","-I","tools/my_candidate_check.py"]]`. Commands execute from the workspace; configure checks suitable for that project. The default observation check is an SDK check, not a proof that every bot action is valid or competitive.

Use `job` with `{"action":"await","id":"JOB_ID"}` to wait without repeatedly asking the model to poll. Inspect logs when needed. Local builds and sweeps remain correctness/comparative evidence.

## 4. Run discovery through the existing controller

`battlecode_live_trial`:

```json
{"id":"EXPERIMENT_ID","stage":"discovery"}
```

This verifies frozen source, correctness and WASM identity, then invokes the existing `live_trial.py` with explicit baseline, source group, candidate and output folder. The project controller performs the live transaction, queues all five games, restores the incumbent and records final active/selected state. The adapter does not invent another queue or selector protocol.

Await and reconcile the trial job, then run `battlecode_collect` with the same ID/stage. Its worker invokes the existing collector until all five results are available. It reuses cached replay downloads and spends no model calls per queue poll. The committed collector result records hashes of receipts, group metadata, results, final platform readback and replay archives.

Live operations can briefly affect the shared selector. Stopping a **live job** sends termination and allows up to six minutes for controller cleanup/restoration; do not expect an immediate hard kill. Double Escape stops the agent's waiting/inference, while detached jobs continue unless explicitly stopped with `psi jobs stop ID`.

`battlecode_report` runs the project's existing report script over the experiment and immutable controls. Reports help diagnosis but cannot qualify a candidate by themselves.

## 5. Make a replay-backed decision

`battlecode_decide` with `{"id":"EXPERIMENT_ID","stage":"discovery"}` requires:

- Unchanged incumbent, frozen candidate source, preselected controls and committed collected evidence.
- A candidate version distinct from the incumbent and an exact source-group/fixture receipt.
- All five games finished, distinct replay/match identities and exact map/opponent/side matches.
- Matching recorded engine identities and server outcomes.
- A matching replay archive SHA-256 and the identity marker in the actual own-team ZIP stdout stream.
- Present, zero runtime-error/fuel-exhaustion counters and no logged errors from the project collector.
- Receipts and settled readback confirming the incumbent is active, selected and pinned.
- No lost incumbent win and at least one recovered incumbent loss.

A passing discovery becomes `discovery_passed`; a regression or no gain is `rejected`. The adapter verifies archived stdout directly and checks the committed collector output, while runtime counters/decoding still rely on the project's existing decoder. It is not a second independent game engine.

## 6. Confirm on the preselected fresh set

For each confirmation control, call trial/collect with `stage: "confirmation"` and a zero-based `index`. Confirmation reuses the **same submitted version and marker** from discovery; it does not upload a rebuilt candidate.

After every confirmation panel is complete, `battlecode_decide` with `stage: "confirmation"` checks the full set. Every incumbent win must remain a win, with at least one gain across the set. Passing records `qualified_for_review`. It does not activate, release or claim broad superiority. Release remains a separate user objective.

## Durable state and recovery

Records live privately under `~/.psi/experiments/ID/`:

- `experiment.json`: authoritative schema-versioned snapshot, incrementing revisions, source/control identities, operations and decisions.
- `events.jsonl`: audit entries for committed revisions.
- `candidate/`: isolated source and builds when Psi created the candidate.
- `trials/`: controller receipts, replay files, decoded results and reports.
- `OPERATION_UUID.result.json`: atomically committed worker outcome and evidence hashes.

Operation intent is persisted before spawning a uniquely labelled job. A repeated trial call returns the known operation instead of creating another paid group. After restart, reconciliation finds the original job/result by ID or label. An unknown live outcome becomes `needs_reconciliation`; it is never silently reissued. Inspect platform/controller state, restore the incumbent if necessary through the existing tools, and use `battlecode_experiment` action `recover_trial` only when the existing queue/restoration receipts are complete. Failed read-only collection can be retried. A machine reboot does not resume a running child process; saved records support deliberate recovery.

Private files and local locks protect normal process coordination, not hostile code running as the same macOS user. Psi enforces the user-approved working directories and adds no approval dialogs. Existing controller CLIs needing personal credentials must be configured within the granted scope.
