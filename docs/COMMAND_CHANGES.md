# Command changes

The following slash commands are removed. Their alternatives are explicit; none of the removed commands remain as hidden aliases.

| Removed | What it did and how it was used | Recommendation |
| --- | --- | --- |
| `/agents` | Opened worker roles, models, effort and concurrency. | Renamed to `/subagents`; keep the new name. All functionality remains. |
| `/provider` | Interactive setup for a custom endpoint, e.g. a local vLLM server. | Keep removed for a quieter command list. Advanced setup still works with `psi provider add --id local --url http://localhost:8000/v1 --model my-model --keyless`. |
| `/cd <path>` | Started a new session rooted in another project directory. | Convenient when moving between projects, but optional. Use `psi -C /path` from the shell; `/directory add` grants additional tool access without changing the session root. |
| `/summary-model provider/model` | Selected a separate model for context compaction; `same` reused the main model. | Keep in `/settings` → Compaction model. A cheaper summarizer can reduce long-loop cost, but this rarely needs its own command. |
| `/checkpoint [note]` | Read or manually replaced the session's durable progress note. | The best candidate to restore if you often steer long experiments: a human can pin exact next steps before compaction. The model's checkpoint tool and existing checkpoint file still work without it. |
| `/continue [instruction]` | Continued a saved unfinished objective with optional steering. | Redundant with entering another message, `/resume`, or `psi --continue -p "instruction"`. Keep removed. |
| `/stop` | Aborted inference and active tool waiting. | Double Escape handles it. A typed alternative is useful for terminals with unreliable Escape handling, but not essential. |
| `/jobs [id]`, `/jobs stop <id>` | Inspected detached build/benchmark output or killed a specific job. | Worth restoring for intensive Battlecode runs: a detached job can outlive inference, so stopping the AI does not necessarily stop it. For now, `psi jobs [id]` and `psi jobs stop <id>` provide explicit control in another terminal. |
| `/budget <dollars>` | Set an estimated session cost ceiling; zero disabled it. | Keep in Settings → Session budget. Useful control, rarely changed during normal use. |
| `/limit <requests>` | Capped requests per run, including retries and summaries. | Keep in Settings → Run limit. A loop waits at the cap rather than claiming completion. |
| `/tokens <count>` | Set maximum output tokens per request. | Keep in Settings → Output tokens. Model choice and effort are the more common interactive changes. |

`/refresh` previously refreshed one provider's dynamic model catalog. It now reloads settings, account selection, provider registrations, tools and UI configuration. Active inference requires confirmation before it stops. Session history, allowed directories, queued messages, unfinished goals and drafts survive. It does not restart inference or install code updates. For updates use `/update`, then restart the process.

Restoring any removed slash command remains a separate choice. The current recommendation is to consider `/checkpoint` and `/jobs` first for hands-on experiment supervision; the remaining functions fit existing commands or settings.
