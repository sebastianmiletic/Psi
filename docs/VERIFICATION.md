# Verification

Verified locally on 2026-10-31 (Australia/Sydney), using isolated temporary homes for tests.

- `npm run verify`: syntax checks and 29 passing tests.
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

No external provider accounts were signed in. Live authentication, paid inference and every third-party adapter have not been individually verified. No real Battlecode bot, live submission or competition result was modified or benchmarked.

## Terminal and logo update

- The real fullscreen renderer is exercised against a deterministic terminal surface at multiple sizes. The prompt remains at the bottom, with its bottom border followed by a model/thinking row and an account usage row.
- Tests cover transcript growth, inline menus, resizing, exact footer contents, SGR mouse events activating the logo, Escape restoration of the draft and complete timer cleanup.
- The logo uses a custom extruded Ψ mesh, perspective projection, face lighting and a depth buffer. It uses no new dependencies, no model calls and no idle animation timer.
- `docs/terminal.png` and `docs/logo-3d.png` are rendered previews of actual terminal frames. Recreate them with `npm run preview:ui` using a supported installed Chromium browser.

## Accounts, usage and Battlecode plan

- Header mesh reduced to 12 columns by 4 rows. The optional 3D view is also reduced. Model is left-aligned; thinking is right-aligned; provider and cost are absent from the footer.
- Each request pins its account before credential resolution. Tests switch accounts during an HTTP request, verify the actual authorization header and independently recorded usage, and verify refreshes cannot overwrite the newly selected account.
- The account UI is exercised with two named API-key accounts from one provider and a third account from a different provider. No external login or paid inference is used.
- Persistent per-account totals are private and include only Psi-recorded activity. Response-reported quota/rate windows are snapshots, and missing/expired quota is unavailable rather than inferred. Arbitrary headers and credentials are excluded from the ledger.
- The Battlecode capability plan was based on read-only inspection of the current project README, VisionV6 manifest, live-tool documentation, current execution plan and tool paths. The explicit cambc400 executable returned version 4.0.0. No Battlecode build, bot edit, live API call, match, upload or selector change was performed.
