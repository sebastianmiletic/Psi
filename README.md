# Ψ Psi

<p><img src="assets/psi-wordmark.svg" width="300" alt="Psi logo"></p>

**Lightweight AI harness made for long and intensive loops.**

![Psi terminal with the prompt pinned to the bottom](docs/terminal.png)

A personal AI coding harness for long Battlecode development loops. A terminal UI, immediate tool execution, persistent sessions, and a benchmark runner that spends no model tokens per game.

Built in JavaScript on Node.js with Pi's model transport and terminal renderer. No Electron, frontend build, local web server or bundled browser. The default model is `openai-codex/gpt-5.6-sol`; all supported providers remain selectable.

## Start

```sh
git clone https://github.com/sebastianmiletic/Psi.git
cd Psi
npm install
npm start
```

The local `psi` launcher can be installed with `npm run install:local`. Then open any project:

```sh
psi -C "/Users/sebastianmiletic/Coding/Cambridge Battlecode 2026"
```

Use `/accounts` to connect an account, `/model` to choose a model, and type your task. Tools execute immediately with full host access. Psi adds no approval prompts or workspace sandbox. Provider sign-in and operating-system access controls still apply.

Requirements: Node.js 22.19 or newer, `rg` for file search, and your normal build/competition tools. Browser tools use an installed Chromium-family browser, including Brave on this Mac. No browser download is required. Set `PSI_CHROME_PATH` for another installation.

## Providers and accounts

The current bundled catalog registers **228 provider adapters and 7,068 tool-capable model entries**. This includes native transports plus compatible API endpoints from the models.dev snapshot. Counts can change when the catalog is updated. Individual third-party endpoints have not all been tested with live credentials.

- Codex/OpenAI, Claude/Anthropic and several other native providers offer their supported sign-in flow.
- Other providers accept API keys or their documented environment variables.
- Store multiple named accounts per provider. `/accounts` directly exposes **Login new account**, **Switch accounts**, and **Remove account**. The switch list includes every saved provider/account.
- Active accounts are selected independently per provider. Switching an account also selects that provider's matching model, or its first model if there is no match.
- OAuth refresh is serialized across Psi processes. Credentials stay in Psi's own account store; existing Pi, Claude and Codex account files are left alone.
- `/provider` adds a custom OpenAI Chat Completions, Responses or Anthropic Messages endpoint. Local servers can use no-key mode. Multiple accounts still work for custom endpoints.

Credentials and session files live under `~/.psi`, with private directory permissions and credential files set to mode `0600`. Credentials are stored as local JSON rather than the macOS Keychain. `PSI_HOME` selects another location, useful for testing. Never commit that folder.

For automated API-key setup, pass the environment variable name rather than a secret in shell history:

```sh
psi accounts add --provider anthropic --name Personal --key-env ANTHROPIC_API_KEY
psi accounts list
psi providers
psi models codex
psi doctor
```

For a local server:

```sh
psi provider add --id local --url http://localhost:8000/v1 --model my-model --keyless
psi -m local/my-model --effort off
```

Custom endpoint prices default to unknown/zero estimates. Set accurate model limits and `cost` fields in `~/.psi/config.json` when using cost ceilings with a custom endpoint.

## Terminal commands

| Command | Purpose |
| --- | --- |
| `/logo` | Open the rotating 3D Psi logo |
| `/model [provider/model or search]` | Search and choose a model |
| `/effort [level]` | Choose a model-supported reasoning effort |
| `/accounts` | Login, switch or remove accounts |
| `/provider` | Add a custom endpoint and model |
| `/loop <objective>` | Work until the objective is finished, interrupted or limited |
| `/continue [instruction]` | Continue saved progress |
| `/stop` | Stop inference and active tool waiting |
| `/jobs [id]` | List jobs or inspect output |
| `/jobs stop <id>` | Stop a background process group |
| `/budget <dollars>` | Estimated session cost ceiling; `0` disables it |
| `/limit <requests>` | Request ceiling for each run, including retries and summaries; `0` disables it |
| `/tokens <count>` | Output token ceiling per model request |
| `/cost` | Usage, cache reads and estimated cost |
| `/compact` | Summarize older context while preserving the full journal |
| `/summary-model provider/model` | Use a cheaper model for compaction; `same` restores the main model |
| `/checkpoint [note]` | Read or replace the persistent progress note |
| `/profile battlecode\|general` | Change system guidance |
| `/new` | Start a fresh session |
| `/resume [id]` | Search saved sessions |
| `/cd <path>` | Start a session in another workspace |
| `/refresh [provider]` | Refresh a supported dynamic provider catalog |
| `/export [path]` | Export the current session context as Markdown |
| `/status`, `/help`, `/quit` | Inspect state, see commands or exit |

The prompt stays pinned to the bottom of the terminal while the conversation scrolls above it. Its single footer row shows only the model, provider and thinking level. Costs remain available explicitly through `/cost`, with no automatic cost display.

Click the larger Ψ mark to expand it into a shaded, rotating 3D mesh. Click again or press Escape to return to your unchanged prompt. `/logo` provides the same interaction from the keyboard. Animation renders only while open and adds no dependencies.

Type to filter pickers, use arrows to navigate and Enter to select. Tab completes slash commands and paths. Shift+Enter creates a newline. Escape stops the current run. Ctrl+C cancels a prompt or run and exits when idle. A normal message typed during a run steers the next tool boundary.

**Stopping generation or quitting does not kill detached jobs.** Inspect them with `/jobs` or `psi jobs`; terminate them with `/jobs stop <id>` or `psi jobs stop <id>`.

## Long, low-overhead loops

```sh
psi -C "/path/to/battlecode" \
  --loop "Freeze the baseline, find and validate an improvement, and save the evidence. Follow AGENTS.md and the competition protocol." \
  --budget 10 --max-steps 300
```

Headless operation:

```sh
psi -C /path/to/project -p "Build the bot, diagnose failures and fix them."
psi -C /path/to/project --continue -p "Continue the next experiment."
psi --resume SESSION_ID --json -p "Report pending work and continue."
```

`--json` emits event JSONL for automation. Use a process supervisor such as `tmux`, `launchd` or your existing runner to survive terminal loss or reboot. Detached benchmark jobs survive a Psi process exit; they do not survive a machine reboot or sleep as continuously running compute.

Psi's normal agent loop continues through tool calls. Autonomous `/loop` also continues after plain responses and uses an explicit `finish` tool to record completion. It pauses after three consecutive autonomous responses without tool progress to avoid repeatedly paying for stalled narration.

Efficiency mechanisms:

- Lazy provider SDK and browser loading. No idle polling or animation timer when the logo view is closed.
- Stable session identifiers and provider-supported prompt-cache hints.
- Configurable reasoning and output budgets; an optional cheaper compaction model.
- Bounded tool results with full text saved to artifact files.
- Parallel independent reads/fetches/searches, ordered writes and edits.
- Detached jobs, bounded logs and a resumable sweep runner instead of one model turn per match.
- Automatic context compaction. Append-only journals preserve evidence; session loading streams the journal rather than reading it all into memory.
- A maximum of 100 visible transcript components, independent of the full disk journal.
- Bounded retries with exponential backoff for transient provider errors; authentication failures surface immediately.
- Writer locks, partial-journal recovery and explicit unknown outcomes for tools interrupted by a crash. Psi does not silently re-execute an uncertain side effect.

Cost is a **catalog-based estimate**, not a provider billing guarantee. Subscription quotas, unknown/custom prices, tiered/long-context rates and provider accounting differences are not fully measured. Before each request Psi reserves estimated input and maximum output cost against `/budget`. Defaults impose no cost or step ceiling. Choose limits appropriate to your account.

## Local benchmark sweeps

Copy [examples/benchmark.json](examples/benchmark.json) into your project and adapt the command to the actual competition runner. Psi does not assume a particular Battlecode engine CLI.

```sh
psi -C /path/to/battlecode bench benchmark.json
```

The model can also invoke the `benchmark` tool with a manifest path. It starts a durable job and returns its ID, so it can continue other useful work and wait later.

A manifest provides:

- An **argv array**, not a shell template. Placeholders: `{candidate}`, `{name}`, `{seed}`, `{side}`, `{map}`, `{repeat}`, plus candidate-specific `params`.
- Candidates with distinct names and paths to frozen artifacts.
- Seeds, maps, sides (default `[0,1]`), repetitions and worker concurrency.
- Optional `inputs` to hash runner scripts, maps or configuration, plus version metadata.
- A stable output directory for resumability.

The runner records artifact SHA-256 values, exact commands, seeds/sides/maps, exit codes, elapsed times and individual log paths. Each match can print a final JSON object containing `"outcome": "win"`, `"loss"` or `"draw"`; other successful output is recorded as unscored. Nonzero exits and timeouts are errors, regardless of any claimed outcome in stdout.

Results are stored in `results.jsonl`, `sweep.json`, per-match logs, and `summary.json`. Re-running the same manifest/output skips recorded matches. Changing artifact or input hashes requires a new output directory. The final check marks results invalid if frozen inputs changed during the sweep. Records are local comparative evidence; they do not establish competitive promotion, ladder performance or actual submission.

## Tools

`read`, `write`, `edit`, `search`, `bash`, `benchmark`, `job`, `fetch`, `search_web`, `browser`, `checkpoint`, `finish`.

`fetch` handles HTML extraction, links, JSON/text, a short cache and full-response artifacts. `search_web` uses DuckDuckGo HTML and reports blocking/no-results errors explicitly. `browser` uses a separate ephemeral headless browser with JavaScript evaluation, links, screenshots and a persistent page for the running Psi process. It does not reuse your personal browser profile. Arbitrary installed CLIs, Python scripts, databases and download tools remain available through `bash`.

Ancestor `AGENTS.md` files are loaded for the selected workspace. The Battlecode profile asks the model to freeze baselines, separate local correctness/comparison from competition evidence, inspect failures/replays and retain checkpoints. It is guidance, not a guarantee of bot quality. Psi does not automatically submit a bot.

Operational debug logging is enabled by default, per the local development preferences. It records event types, model labels, retries, tool names, durations and errors, without recording raw provider payloads or credential values. Full conversation and tool content are stored in the separate private session journal. Use `--no-debug` to disable operational logging.

## Development

```sh
npm run verify
npm run catalog:sync
```

Tests use an isolated local OpenAI-compatible streaming server and temporary data folders. They cover real HTTP tool cycles, account isolation and refresh locking, costs/limits, retries, resume/crash recovery, process cancellation, website extraction, the installed browser, paired benchmark sweeps, bottom-pinned layout through terminal resizes, footer contents, mouse-triggered 3D animation and timer cleanup. They do not spend paid inference or sign into external accounts. Provider login and all third-party endpoints still need verification with your own accounts.

Transport and terminal rendering: [Pi](https://github.com/earendil-works/pi). Additional provider data: [models.dev](https://models.dev). Codex authentication reference: [official OpenAI documentation](https://developers.openai.com/codex/auth). Dependency licenses remain with their respective packages.
