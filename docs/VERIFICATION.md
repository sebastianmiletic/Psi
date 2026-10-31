# Verification

Verified locally on 2026-10-31 (Australia/Sydney), using isolated temporary homes for tests.

- `npm run verify`: syntax checks and **111 passing tests**.
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
