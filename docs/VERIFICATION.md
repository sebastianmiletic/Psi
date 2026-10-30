# Verification

Verified locally on 2026-10-31 (Australia/Sydney), using isolated temporary homes for tests.

- `npm run verify`: syntax checks and 24 passing tests.
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

- The real fullscreen renderer is exercised against a deterministic terminal surface at multiple sizes. The prompt remains on the third-last row, with its bottom border followed by the model/provider/thinking footer.
- Tests cover transcript growth, inline menus, resizing, exact footer contents, SGR mouse events activating the logo, Escape restoration of the draft and complete timer cleanup.
- The logo uses a custom extruded Ψ mesh, perspective projection, face lighting and a depth buffer. It uses no new dependencies, no model calls and no idle animation timer.
- `docs/terminal.png` and `docs/logo-3d.png` are rendered previews of actual terminal frames. Recreate them with `npm run preview:ui` using a supported installed Chromium browser.
