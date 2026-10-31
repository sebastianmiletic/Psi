# Pi, Codex and Psi

Compared against the current primary documentation on 2026-10-31 and Psi 0.2.11 source. These are first-class product features; calling an external CLI through Psi's shell is different from providing its own integration.

| Feature | Available in | Psi today |
| --- | --- | --- |
| Installable extensions, skills, prompt templates, themes and shared packages | Pi | No extension loader or package/skill discovery. Psi has built-in tools, project instructions, configurable colours and provider endpoints. |
| Session tree, fork and clone workflows | Pi | New/resume/compact/export exist; interactive branching and fork selection do not. |
| Embeddable agent SDK and bidirectional RPC | Pi | Headless prompts and event JSONL exist; no supported public SDK or interactive RPC protocol. |
| Image paste/drop and file mention search in the composer | Pi and Codex image input | Psi can read image files through its model tool, but has no clipboard-image attachment or file-mention picker. |
| Native MCP and plugin connections | Codex | No MCP client, connector authentication or plugin manager. Existing shell/browser tools cover some tasks manually. |
| Dedicated Git review presets and structured findings | Codex | A model/reviewer worker can inspect Git through tools; no dedicated review UI against commits, base branches or uncommitted changes. |
| Hosted cloud execution and IDE integration | Codex | Local terminal/headless execution only; no hosted service or IDE extension. |

For long local Battlecode loops, the most useful next additions would be session branching for experiments, a skills/hooks loader for repeatable validation, and structured Git review. MCP is useful when competition tooling exposes a server; an SDK/RPC layer would let external controllers supervise Psi directly. These are proposed additions, not implemented features.

Psi already supplies persistent objectives, account switching, configurable workers, plan/execute enforcement, directory boundaries, browser extraction, detached jobs, local benchmark sweeps and a project-specific replay/fixture qualification workflow. Its statistics describe Psi-recorded activity rather than all activity on a provider account. Pi's core deliberately leaves subagents and plan mode to customization; do not mistake those for missing Psi features.

Sources: [Pi overview and extensibility](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [Pi terminal workflows](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md), [Codex CLI capabilities](https://learn.chatgpt.com/docs/cli). Psi's effort interaction follows the arrow/Tab/Enter pattern described in [Claude Code model configuration](https://code.claude.com/docs/en/model-config), using Psi's own provider-supported effort levels and OVERKILL workers.
