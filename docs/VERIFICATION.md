# Verification

Verified locally on 2026-10-31 (Australia/Sydney), using isolated temporary homes for tests.

- `npm run verify`: syntax checks and **70 passing tests**.
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
