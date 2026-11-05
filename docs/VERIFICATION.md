# Verification

Verified locally on 2026-10-31 (Australia/Sydney), using isolated temporary homes for tests.

- `npm run verify`: syntax checks and **164 passing tests**.
- Real HTTP SSE requests to a local OpenAI-compatible fixture executed file writes, a detached shell job, website extraction and objective completion. No paid inference was used.
- A new process can reconstruct messages, usage, pending goals and tool outcomes from the session journal.
- Tested serialized multi-account refresh, private credential file mode, transient retries, authentication failure handling, budget/request limits, compaction, torn-journal recovery, writer contention, stale-session rejection and cancellation.
- Tested detached job success, nonzero exit, timeouts, explicit stop and log-size bounds.
- Tested local Brave headless rendering, JavaScript evaluation and process closure.
- Tested benchmark pairing across seeds and both sides, artifact hashes, per-game records, resumed sweeps without duplicates and errors excluded from wins.
- Tested terminal width bounds and secret prompt masking. Manually exercised the live PTY startup, account menu, search, cancellation and quit.
- Live network smoke checks fetched and extracted Example Domain and returned web search results for Cambridge Battlecode.
- Installed and verified `~/.local/bin/psi`; `psi doctor` found ripgrep, Brave, 228 provider adapters and 7,068 model entries.
- One provider-registry startup measurement: approximately 90 ms initialization, 92 MiB process RSS and 18 MiB JS heap. This is a local observation, not a performance guarantee or a full inference benchmark.

Unit/integration tests use fixtures. A separate real Codex Harness-Bench run reuses existing OAuth credentials; see [the results and limits](HARNESS_BENCH.md). Every third-party adapter has not been individually verified. No real Battlecode bot, live submission or competition result was modified or benchmarked.

## Terminal and logo update

- The real fullscreen renderer is exercised against a deterministic terminal surface at multiple sizes. The prompt remains at the bottom, with its bottom border followed by a model/thinking row and an account usage row.
- Tests cover transcript growth, inline menus, resizing, exact footer contents, SGR mouse events activating the logo, Escape restoration of the draft and complete timer cleanup.
- The logo uses a custom extruded Ψ mesh, perspective projection, face lighting and a depth buffer. It uses no new dependencies, no model calls and no idle animation timer.
- `docs/terminal.png`, `docs/logo-3d.png` and `docs/settings.png` are rendered previews of actual terminal frames. Recreate them with `npm run preview:ui` using a supported installed Chromium browser.

## Accounts, usage and Battlecode adapter

- Header mesh reduced to 12 columns by 4 rows. The optional 3D view is also reduced. Model is left-aligned; thinking is right-aligned; provider is absent from the footer. The account row now shows reported subscription windows or metered session cost.
- Each request pins its account before credential resolution. Tests switch accounts during an HTTP request, verify the actual authorization header and independently recorded usage, and verify refreshes cannot overwrite the newly selected account.
- The account UI is exercised with two named API-key accounts from one provider and a third account from a different provider. No external login or paid inference is used.
- Persistent per-account totals are private and include only Psi-recorded activity. Response-reported quota/rate windows are snapshots; absent/unlimited/expired subscription windows are omitted. Arbitrary headers and credentials are excluded from the ledger.
- The Battlecode capability plan was based on read-only inspection of the current project README, VisionV6 manifest, live-tool documentation, current execution plan and tool paths. The explicit cambc400 executable returned version 4.0.0. No Battlecode build, bot edit, live API call, match, upload or selector change was performed.

## Persistent goals, settings and account recovery

- Goals continue through plain final responses and temporary HTTP failures, and finish only after existing evidence is supplied. Nonexistent finish evidence is rejected. A user stop preserves the unfinished goal for resume.
- Reached budgets keep goals waiting without spending further model calls. Changing settings wakes the waiting loop. Known exhausted accounts cause no inference requests, even when automatic switching is off.
- A local HTTP fixture verifies automatic same-provider account failover and explicitly configured cross-provider model fallback, including actual credential headers. These are simulated quota errors, not external paid requests.
- Mock Codex and Claude usage responses exercise five-hour/weekly schemas, absent/unlimited windows, per-account refresh TTL and HTTP 429 backoff. Request-rate headers preserve subscription windows; an authoritative empty usage refresh clears them.
- A provider-returned billed USD amount overrides catalog cost and survives session reconstruction. Unknown model pricing stays unavailable. Other endpoints may return token usage without billed USD; those costs use configured model rates.
- The real settings menu is exercised for colour, account switching and token changes. Appearance changes during inference apply immediately; execution changes apply at the next boundary. Session writes are serialized while settings and inference events overlap.
- Event-driven job waiting completes without model polling.

## Offline Battlecode integration

- A temporary project fixture provides executable controller, collector, reporter, compiler and real ZIP replay files. The full workflow builds and freezes an isolated candidate, runs discovery, reuses its submitted version on preselected fresh confirmation, and records `qualified_for_review` only after both complete sets pass. Baseline files remain unchanged.
- Tests reject duplicate confirmation fixtures, candidates overlapping the incumbent, changed frozen source, missing actual stdout markers despite a forged `marker_verified` flag, incumbent-win regressions and edits to collected evidence.
- A persisted ambiguous live launch is never repeated after recovery; incomplete restoration receipts are refused. Fresh baseline controls run through the same durable controller/collection path and can become immutable preselected controls.
- A cancellation fixture confirms a live controller can complete cleanup beyond the ordinary two-second job kill window; the interrupted transaction then requires reconciliation.
- The real project's `python3 -I -m unittest discover -s tools/vision -p test_live_trial.py -v` passed **9 offline controller tests**, using injected command fixtures rather than platform calls.
- Read-only inspection of the real checkout confirmed the documented v248 manifest and 53 source identities. No live platform state was fetched as part of that inspection.
- The Python archive-verification helper parses successfully. It hashes the archive and streams the actual own-team stdout member to verify the identity marker.

Actual API invoices and real competition transactions were not exercised in this verification. The adapter depends on the current project's scripts and decoder; it does not independently implement the game engine or establish a stronger bot from fixtures alone.

## Psi 0.2.0 workflow and distribution

- Added approved-directory file checks, symlink resolution and OS-isolated shell execution. A real Python process is denied reads/writes outside a permitted sibling boundary; credential-like environment variables are omitted. Python aliases and zsh heredocs stay in private scratch.
- Tests enforce plan-mode mutation denial, mode switches before returned tool execution, double Escape, Shift+Tab, OVERKILL via Tab in `/effort`, skipped stale calls after queued steering and persistent message delivery.
- Real child processes exercise configured subagent models, inherited scope, plan-only children, follow-ups after completion and deduplicated parent usage accounting.
- GitHub stable-release checks, cache timing and semantic version comparisons are covered. Release installers use verified archive digests and preserve source checkouts with local changes.
- Pi import tests cover idempotency, unchanged source selection and shared refresh locking. Two existing Codex accounts were imported locally; import preserved the original Pi file byte-for-byte, and no browser sign-in was requested. Account credentials are excluded from Git.
- The real Harness-Bench smoke subset scored 1.0, 0.0 and 1.0 on tasks 009, 010 and 028. This is reported separately from unit tests and retains the failed task.
- Native Windows shell execution intentionally fails closed; WSL2 with bubblewrap is required. Windows file/research tools and model workers are exercised by the portable CI suite. POSIX permission assertions apply only on POSIX hosts.

- Windows CI exposed transient file-sharing violations during atomic snapshot replacement. Writes now retry those bounded errors while preserving the prior committed file; a fault-injection test covers the behavior. Worker completion/exit races and cross-platform graceful cancellation also have explicit tests.

- A Linux watcher race could defer completed jobs until the 30-second backup check. Completion events arriving during an in-flight read now schedule a fresh read, with a deterministic regression test.

## Message and composer polish

- The actual terminal renderer verifies the PLAN/EXECUTE control on the top input border, mouse toggling, multiline draft preservation and narrow-width bounds.
- Deterministic animation-time checks verify eased send feedback and active response motion, immediate full streamed text, and timer cleanup at completion and close.
- Disabled UI animations retain static response/tool state without animation timers. Tool-only requests leave no empty assistant message, completed tool rows update in place, and background job identity/status remain visible.
- Progress uses full-height solid blocks. Wide terminals also show the estimated remaining percentage.
- `docs/conversation.png` is a preview from the actual renderer with illustrative data, not evidence of a live Battlecode experiment.

## Effort, account quota and historical statistics (0.2.4)

- Dedicated staged effort slider: arrows adjust supported levels, Tab previews OVERKILL, Enter commits and Escape discards. One Escape closes submenus without stopping an active run. Mode/effort changes stay out of the conversation and model transcript.
- Deterministic terminal frames verify full-width slash input, clickable mode control, accent flow at different times, static reduced motion and complete timer cleanup. The footer shows only the bare effort value.
- The solid blue meter selects a current reported five-hour quota before weekly/other windows, and falls back to explicitly estimated goal progress when no quota exists. Secondary quota windows remain visible in the account row.
- Historical statistics verify calendar periods, token categories, worker receipt deduplication, overlapping wall time versus summed agent time, incremental partial appends, truncation, active process locks and crash recovery. The private cache excludes prompt content, and reading statistics does not repair or mutate session journals.
- The real `/stats` overlay is exercised at 100×32, 68×24 and 28×18, including period navigation, one-Escape closure, unchanged draft and zero model calls.
- Real renderer previews in `docs/effort.png`, `docs/stats.png` and `docs/overkill.png` use illustrative data. They are UI evidence, not live account or competition results.

## Compact menus and repository identity (0.2.5)

- The original normal-height terminal logo frame was compared with 0.2.4 and matches exactly when OVERKILL is off. Repository SVG/PNG art is redesigned separately.
- Header visibility is exercised through effort, statistics, settings and tool panels. Narrow terminals retain their prompt and selected tab; compact panels do not create full-screen overlays.
- Quota tests verify five-hour-first ordering beside the account, all windows as remaining percentages, an empty bar at 0% left, a full bar at 100% left, and the selected accent rather than fixed blue. Goal fallback is explicitly estimated work remaining.
- Animation checks compare the input borders, quota meter and terminal logo at different times, and verify static reduced motion and timer cleanup. OVERKILL uses a filled badge and heavier borders.
- Removed slash commands are rejected, without hidden aliases. The tool list is a paged name grid. Compaction model selection remains in Settings; account/provider capability remains intact.
- Real local HTTP and worker fixtures verify reload cancellation, stopping on confirmation, confirmation for a worker still running after its parent, rebuilt registries/tools, and preserved session identity, context, directories, queued messages and draft. Reload performs no replacement inference call.
- `npm run preview:ui` renders actual terminal frames with illustrative activity; `npm run preview:brand` renders the code-native vectors without external image/font services or paid model calls.

- Visible labels and values both filter correctly, including Motion and Compaction model whose stored setting keys differ.

## Account resets (0.2.7)

- Six new reset tests cover account-pinned discovery, quota and credit parsing, idempotent recovery after an uncertain redemption, zero/unsupported/foreign-account rejection, compact UI confirmation and cancellation, Claude web routing, and stdio authentication preflight/process cleanup.
- A read-only check against the existing selected Codex account returned quota windows and credit metadata. The saved Codex login hash was unchanged. No real credit was redeemed and no paid inference was used.
- The account footer omits five-hour quota and keeps weekly percent left. The bottom meter retains five-hour-first behavior. Budget/request/token limits and Compaction model remain in Settings.
- Linux and Windows CI include the reset tests using a local protocol fixture; the installed Codex binary is optional and not required by the test suite.

## Quieter bars and account rows (0.2.8)

- Input and usage-bar waves move 35% slower, with a narrower brightness range. The existing reduced-motion and animation/timer checks pass; logo motion is unchanged.
- Account switch/remove rows show only provider and account name. Codex is shortened to `codex`; active markers, authentication type, account IDs and usage details are omitted. A focused regression verifies the list still uses stable IDs internally.
- Read-only inspection confirmed the unwanted entry was already absent from the local Psi store. The separate Pi source login was left intact. No account-removal code or personal account names were added to the product.

## Models and automatic subagents (0.2.9)

- Eight integration checks verify short model labels, full route preservation, real-composer filtering, duplicate-label collapse, draft restoration, keyboard selection, right-aligned clickable OVERKILL and narrow bounds.
- Real local child processes verify automatic bounded startup, role/task names, per-profile models/effort, plan-only advisory permissions, result integration before final completion, usage deduplication, mid-request enabling, parent resume and double-Escape cancellation. Fixtures use no paid inference or live competition calls.
- Subagent activity is written at state/tool transitions and observed through filesystem events. Job completion is event-driven; observers close on exit/session changes. Results are persisted and delivered once per recorded job identity.
- Models, effort and worker-row screenshots come from actual terminal frames with illustrative data. Manual execution delegation remains supported; automatic kickoff workers inspect without concurrent project edits.

## Conversation layout and session names (0.2.10)

- Subagents are verified below the usage bar at 100×32, 68×24 and 28×18, including while a menu is open. Model/account/quota order stays stable.
- Six new tests exercise inline response bullets and full Markdown streaming, grouped exploration, Ctrl+T disclosure without inference, bounded shell previews, failures, edit snippets, background job identity, interrupted states and persisted session naming.
- `/name` is verified while busy, through session list/resume, with cancellation, invalid titles and an explicitly named “New session” that cannot be overwritten by later prompts. Context and unfinished objectives remain intact.
- Presentation follows the public Codex [message](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/messages.rs) and [execution-cell](https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs) conventions: bullet responses, grouped exploration and indented command output. Psi retains its renderer, logo, tools and account features; this is not a copy of the Codex implementation.
- The conversation screenshot uses actual rendered frames with illustrative checks, not a live competition result.

## Shutdown ordering (0.2.11)

- The release run exposed a Windows fixture teardown race while a mode switch was still saving settings. The main-branch matrix at the same head passed, but the duplicate tag run was cancelled for diagnosis.
- Shutdown now waits for an in-progress mode change and never starts a quota monitor after closure. A gated regression checks this without timing assumptions.
- Workflow tests await mode changes directly. Shared fixtures stop apps/workers and close HTTP connections before removing temporary homes, with bounded Windows file-sharing retries.

## Active subagents and reload alias (0.2.12)

- Finished subagents disappear from the footer immediately, making room for other active workers. Saved records, report delivery and follow-up reuse remain intact. Rendering tests cover overflow, completion, failure, cancellation and follow-up activation.
- `/reload` and `/refresh` share the same runtime rebuild. Tests verify disk settings, preserved context/directories/queue/draft, and cancellation or confirmation during inference and independent worker activity.

## Workspace identity and account search (0.2.13)

- Header tests check the chat name above the saved directory at wide and narrow sizes and in menus. Selecting a workspace rebuilds file/tool resolution and survives changing/resuming chats without adopting the launcher directory.
- Model and account pickers share the real composer; account tests verify draft restoration, no inference or conversation mutations, per-account countdown/credit rows, concurrent refreshes and ignored late updates after Escape.
- `session_title` permits one automatic title during normal model work, including plan mode. Manual names win, including concurrent naming and session reload. Missing subscription windows and API plans omit reset metadata; unavailable or cached data is identified. No live provider credentials or paid inference were needed.

## Direct workspace selection (0.2.14)

- `/directory <path>` is the sole directory command; switching rebuilds tools and replaces the previous workspace grant after stopping active session processes. Existing symlink isolation, saved-directory resume and reload checks cover the change.
- Header labels use `~/` plus the home-relative path with forward slashes. A regression check excludes sibling homes from tilde shortening. Paths outside the home retain their absolute identity.

## Model-directed OVERKILL delegation (0.2.15)

- OVERKILL no longer starts workers before inference or when enabled mid-request. Real local inference fixtures verify zero initial workers, then explicit model assignments, distinct task names, execution through a legacy read-only preset, file changes, result integration and exact-once usage.
- Workers can use the main model without a preset or select configured model/effort/limit presets. Parent plan mode remains read-only. Finish/report gating, double-Escape cancellation and resume recovery retain coverage.
- Required names contain one to five words and describe a task. Generic roles and duplicate names (including case/punctuation variants) are rejected before launch, even when requests arrive concurrently. Child sessions persist the same task name.

## Automatic final reviews and live usage (0.2.16)

- `finish.report` is published after evidence and subagent gates, with no second request. Reports survive restart/export and recover exactly once when publication was interrupted. Legacy missing reports receive text-only review requests. Failed completion never publishes a success report, and tool calls after completion are skipped. Plan progress no longer suppresses the actual final plan.
- New tests cover no-extra-request reports, legacy report recovery, evidence rejection, journal recovery, plan explanations, sending while scrolled up and precise subscription usage freshness. Provider refreshes use 5–30 second caching, default 15 seconds, plus response/account boundaries, and protect against stale account refresh responses. Missing quota is not replaced with goal progress.
- [Paired Codex comparison](CODEX_USAGE_COMPARISON.md): twelve real 0.2.15 cells, two trials across three original Harness-Bench tasks, medium effort and no subagents. Psi used 19.8% more total tokens and 41.4% more rate-card credits overall. These results predate 0.2.16 and do not claim savings from new behavior. Counter-normalization tests prevent cached input/reasoning double counting.

## Portable stats readiness (0.2.17)

- Windows release validation exposed an existing fixed 60 ms wait in the stats panel test. The test now waits for the loaded Tokens state, with a bounded deadline, before checking the layout. No runtime behavior or model call was added. The failed 0.2.16 release remains unpublished.

## Unsaved session drafts (0.2.18)

- Session history saves chats with a name or a real message. The first message persists its generated title; settings-only and untouched sessions remain drafts. Named empty chats are retained. Empty sessions are removed on close and session switching after checking the durable journal, lock and active jobs.
- Tests cover empty drafts, named empty chats, first-message saving, `/new`, preserving a message committed by another writer, active locks, and legacy snapshots. No inference was used.

## Caching, bounded delegation and nested workers (0.2.19)

- Cache fixtures compare actual serialized instruction/tool prefixes across naming, mode changes and resumed runs. Runtime state appends without entering visible history. Final-review schemas remain stable with tool choice none; compaction has its own short prefix. Hash/size telemetry contains no prompt text or credentials.
- Independent reads overlap in one response. Progress receipts avoid repeating plans. Repeated reads return an unchanged reference only if the complete earlier result remains in context; edits and compaction return fresh content. Default job waits await locally without polling inference.
- Nested worker tests verify one parent chat, preserved results/follow-ups, and exact-once token accounting. Migration tests compare original journal bytes and verify preserved artifacts, legacy path resolution, idempotence and active-lock skips.
- Delegation guards reject duplicate active task prompts, overlapping reserved execution paths and missing rationale. Real worker subprocesses report requested-but-unexecuted checks as unverified. Completion receipts hash regular evidence files; directory evidence is rejected. No paid/subscription inference was used for this update, and historical benchmark results are unchanged.

## Subagent model selection (0.2.20)

- Settings and subagent presets share the searchable main-composer model picker. Escape preserves an existing override, and Default restores inheritance. Saved settings persist independently of the main model.
- Captured worker manifests verify the 5.6 Sol default, independent per-preset model overrides and compatibility with older configurations. These tests make no provider requests.

## Native Claude connection and unrestricted worker presets (0.2.21)

- Native account routing and two-turn tool/result integration are tested through the full Psi engine with fixture Claude Code output. The CLI owns subscription sign-in; stored account descriptors contain configuration references and no copied OAuth tokens.
- Tests cover separate account directories, native failure usage receipts, malformed/unavailable tool responses, image rejection, stdin and cancellation, legacy role migration, and removal of name/job fields from settings. Native auth status confirmed an existing sign-in on the development laptop; no live paid inference was run.
- The laptop configuration explicitly sets the subagent default and all three general-worker presets to openai-codex/gpt-5.6-sol in execute mode. Saved legacy role presets normalize on resume.

## Footer reset countdowns (0.2.22)

- The five-hour meter and weekly account line show their own reset countdown beside percent left, using reported reset timestamps. Tests cover hour/minute and day/hour formatting, elapsed time, missing/invalid resets, unchanged quota values, and narrow terminal widths. The existing usage polling/render loop updates these without model requests.

## Local session durability repair

- Actual process-kill tests verify recovery of flushed live text, and request-payload tests verify that incomplete text stays out of inference history.
- Tests cover last-activity ordering, default resume and saved directories, committed first-message recovery, torn trailing records, durable queued input, graceful close, complete visible-history restore, role-free reload and source-change restart preserving the draft.
- This repair is local while the independent efficiency publication gate runs. Existing unsaved text from older builds cannot be reconstructed if it was never written.

- Header/update tests cover version identity, persistent available/installed notices, checksum and dependency failures, managed activation and preservation of dirty source checkouts. A real parallel fast-command test covers worker completion handler registration and ordered metadata snapshots.


## Profile-free task groups (0.2.23)

- All 167 local tests pass. New tests exercise 40 simultaneous durable worker assignments without provider requests, restoration beyond 32 workers, restart/follow-up beyond the old cap, shared task groups, complete overflow counts, narrow layouts and per-worker model routing.
- Legacy presets and count settings are ignored from both machine configuration and saved session settings. The runtime prompt, tool schema, Settings and Subagents menu no longer offer worker profiles. Duplicate tasks, conflicting file ownership, plan-mode restrictions and exact-once accounting remain covered by the integration suite.
- Startup performs a fresh read-only release check, while the pinned version/update notice remains covered at narrow widths. The release is prepared in an isolated worktree; publishing does not install it on the development laptop. No end-to-end inference-usage improvement is claimed for this feature release.


## Complete interactive startup (0.2.24)

- The regression test first reproduced `ReferenceError: readJSON is not defined` through `App.startUI()`. The missing import is fixed, and cached update state loads before raw mode. Failures after raw mode restore the terminal before the CLI reports an error.
- Full startup tests cover saved history/draft restoration, the version and update command, a fresh release check, retained notices while offline, cleanup after worker-restore failure, and recovery from damaged update-cache JSON.
- A real CLI launch in an isolated pseudo-terminal displayed the composer, running version and cached update command with no startup ReferenceError. The installed laptop code/launcher were not changed. Development worktrees were relocated beneath the main project's `.worktrees/` directory using `git worktree move`; historical benchmark paths have a local relocation map.


## Compact conversation and terminal ownership (0.2.25)

- Prompt disclosure is tested through actual mouse/keyboard routing, narrow/Unicode layouts, draft preservation, exact model input and journal resume. Activity tests cover hidden routine successes, visible failures and important actions, file grouping, worker reports, full-detail settings, and retention of visible prompts during long routine-tool sequences. No paid inference is used for these checks.
- Concurrency tests cover live inference locks, two separate interactive apps making simultaneous fixture requests, atomic startup reservation, real owner-process termination, session switching/reload, empty active-chat protection and cleanup. UI ownership is independent of the existing run lock; that lock is retained.
- All 182 local tests pass. A real two-terminal pseudo-TTY check opened separate chats in the same workspace, expanded the prompt with Ctrl+P, and quit both processes cleanly without a lock collision or paid model request.
- These changes make no claim of reduced total inference usage. Disclosure and filtering are local rendering operations and preserve task evidence.


## Saved conversation reconstruction (0.2.26)

- Cold-reopen tests cover important file changes, progress, delivered worker reports, the latest input, and saved quota-waiting state. They trap tool execution during restore and assert unchanged inference messages and zero provider requests.
- A chat with an empty compacted inference context still restores its saved visible messages. Bounded history retains visible evidence ahead of routine tools and excludes model thinking/image payloads from the display index.
- A private copy of the existing Battlecode journal was replayed successfully: recent activity, latest input and paused status appeared together. The original journal was backed up and left unchanged. UI history is a projection of existing durable records; no tool or provider action is replayed.

## 0.2.27 — compact lossless storage

- All 197 local tests passed. New regression coverage checks legacy migration and torn-tail repair, cold reopening of compressed messages/state, exact statistics across rotation, read/export of archived history, recovery with both raw and compressed segments, checksum failures, concurrent readers/appends, shared tool downloads, idle-only maintenance, bounded disposable caches and verbose compressed diagnostics.
- A private isolated copy of the real Battlecode journal (29,707,639 bytes, 11,821 events) compressed to 7,210,275 bytes including its header: 75.73% smaller. Complete reconstructed bytes matched SHA-256; inference messages, visible history, state, totals and calendar statistics were identical. The user's active files and installed application were not converted or upgraded by this verification.
- Compression uses only built-in Node APIs. Native Windows, Linux and macOS CI exercise the same storage tests; no provider requests are required by these regressions.

## 0.2.28 — automatic storage maintenance

- All 204 local tests passed. Seven new regressions cover persisted throttling, exclusive background ownership, retry after errors, timer cleanup, actual interactive lifecycle hooks, a real detached worker, ordinary print-mode CLI cleanup without a storage command, and reopening while maintenance owns a chat's locks.
- Normal CLI sessions schedule short-lived background maintenance at startup and periodically; closing or switching a chat schedules a targeted pass after its UI lease is released. Subagent processes do not start their own schedulers. Existing per-session live saving and compression remain unchanged.
- Maintenance locks identify themselves so reopening waits briefly rather than showing another terminal's busy-chat error or selecting a fresh conversation. Active model/tool jobs are still protected by their normal locks.
- Windows worker-startup test waiting now uses an eight-second deadline rather than a fixed 150 short timer iterations. The previous release exposed variability in OS child-process startup; all original cancellation and footer assertions remain intact.

## 0.2.29 — themed update progress

- All 211 local tests passed. New coverage checks streaming download hashes/byte counts, missing lengths, incomplete/oversized transfer cleanup, accent colours, OVERKILL flow, narrow terminals, reduced motion, bounded timers, error cleanup, plain output, JSON output and staging/activation progress.
- The updater reuses the composer's accent-wave implementation, caps animation at 12.5 fps, and adds no artificial waiting period. Known download lengths produce actual percentages; installation and unknown-length work remain indeterminate.
- A real pseudo-terminal smoke test streamed a 1,049,955-byte archive into a private fixture installation, ran native tar and npm ci, and activated fixture version 9.0.0. The capture confirmed animated OVERKILL output, download/installation stages, completion and successful exit. No user installation or paid model request was involved.
- Real renderer frames were inspected in sage, cyan OVERKILL and narrow rose layouts. The old caller continues using its existing display while installing this release; subsequent `psi update` runs use the new screen.

## 0.2.30 — visible updater completion and local preview

- All 214 local tests passed. Regressions cover retaining a completed/failed terminal panel, showing an honest up-to-date status without a download percentage, a local visual preview that preserves installed state, actual CLI preview parsing, and clean JSON output with a TTY.
- Read-only diagnostics in the user's Termatica shell confirmed both output streams are TTYs and TERM=xterm-256color. Saved cyan, OVERKILL and animation settings were enabled. The laptop had just installed 0.2.29 using the preceding updater version.
- The new preview was run inside a separate Termatica window using the user's saved theme. Native screenshots verified the moving download display and the retained cyan 100% completion bar. No release lookup, installation or provider request occurred. The temporary diagnostic window was closed; the original terminal/shell processes remained running.
- Actual updates still add no animation delay. `psi update --preview` is an explicitly labelled local simulation for checking the visual effect immediately.

## 0.2.31 — stable minimal update meter

- All 215 local tests passed. A new regression checks that meter width is unchanged at 0, 9, 10, 50, 99 and 100 percent across narrow/wide terminals, and completed download fill survives verification, unpacking, installation and activation.
- The meter reserves a fixed percentage field and no longer replaces completed downloads with a moving block during later stages. The chosen accent and optional flow remain; the Preview/OVERKILL labels and preview completion sentence are removed from the human display. JSON retains explicit preview metadata.
- The revised display was checked in native Termatica with saved cyan/OVERKILL settings. The final screen showed only Ψ/version, Ready and the full meter, without the removed labels or extra sentence. The preview still performs no release lookup, installation or provider request.

## 0.2.32 — optional open after update

- All 222 local tests passed. The new Open after update setting defaults off, validates boolean values, and persists through the normal Settings UI.
- Successful interactive command-line updates may launch the exact installed entrypoint in the same terminal. Source updates return their own entrypoint even if another managed installation exists. Default-off, current, preview, JSON and noninteractive paths do not launch.
- A real child-process fixture verified directory/home inheritance, saved-chat arguments and exit-code propagation. Signal tests verify the waiting parent does not exit before the child on terminal SIGINT and removes handlers afterward.
- Manual `/update` tests verify opt-in reopening saves the same conversation and unsent draft and releases the UI lease before handing off. Current, failed and active-run update cases never reopen. No real user installation or setting was changed by these tests.


## Fresh startup and named sessions (0.2.34)

- The 0.2.33 release was withheld when Windows caught a POSIX-only expected path in the new startup fixture. The assertion now uses the platform’s resolved root.
- Default interactive and noninteractive startups create a fresh chat without consulting the last-chat pointer. Explicit resume restores saved history and its directory; continue remains scoped to the current workspace. Multiple simultaneous launches leave existing saved journals untouched.
- Naming a chat or sending a message makes it discoverable immediately and keeps it after close. Durable name events survive a missing snapshot and protect against stale-writer cleanup. Untouched, settings-only and unsent-only drafts remain hidden and are removed on normal close/switch. Existing active-work and writer-lock safeguards remain in place.
- Four real PTY CLI launches verify fresh defaults, empty cleanup, named-empty persistence and explicit resume. The corruption fixture accepts Node’s alternate Brotli “Decompression failed” error while still requiring corrupted data to fail and restored data to decode. Tests use temporary homes and local fixtures; no paid inference or real user-session changes.


## Expandable subagent groups (0.2.35)

- Actual renderer and SGR mouse events verify expanding/collapsing a group, composer movement, task details below usage, unchanged draft/focus and no model requests.
- A 60-worker fixture checks mouse-wheel access to every expanded task, the pinned collapse control, narrow/short terminal resizing, independent group expansion, picker layout, live membership changes and automatic removal of completed groups. Overflow and Ctrl+G expose all groups; switching chats clears expansion.


## Prompt folding and disconnected streams (0.2.36)

- Short prompts stay unfolded at widths 12–100, with multiline and Unicode fixtures, terminal resizes, Ctrl+P and unchanged composer drafts. The 1,800/1,801-character boundary is covered; long prompts retain exact input and saved history.
- A real local HTTP/SSE connection drop reproduced the raw `terminated` failure before the repair. It now retries within the configured ceiling, keeps incomplete tool calls unexecuted, and completes without a false stopped label.
- Adapter-side aborted results and internal AbortError failures recover independently of genuine cancellation. User stop during streaming/backoff still stops without another request. Exhaustion reports an explicit connection error; request limits remain enforced. No paid inference or user-session edits were used.
