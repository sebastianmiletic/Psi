# Psi terminal design

## Context and theme

A developer works for hours in their existing terminal, often through long evening benchmark sessions. Psi inherits that terminal's background and font, preserving its configured ambient-light contrast and text size.

## Color

Restrained. One sage accent, `oklch(68% 0.105 162)`, identifies Ψ, active selections and links. Default foreground supplies body text; terminal dim supplies secondary text. Red always accompanies a written failure label. No background fill or gradient.

## Typography

Use the terminal's configured monospace font. Bold distinguishes product and picker titles. A larger, shaded Ψ mark, rendered from a small extruded mesh, brands the workspace. Keep the nearby wordmark and workspace path compact.

## Layout

A fullscreen terminal viewport contains the workspace header, a scrolling conversation and inline selection panel. The multiline prompt is pinned to the bottom on startup, during output and through resizes. A single row below it contains only model, provider and thinking level. Do not show costs, run state, token counts or keyboard hints in that row. Conversation scrolling and selection use the terminal renderer; the visible document returns to shell scrollback on exit. Pickers filter immediately and expose keyboard hints. Narrow widths truncate metadata before primary actions. Tool results show short previews, with full results in session artifacts.

## Interaction

Slash commands and Tab completion; Enter submits; Shift+Enter adds a line; Escape stops a run or closes a picker; Ctrl+C cancels a prompt or active run and exits when idle. Pickers support arrow keys and text search. The logo alone has an explicitly requested, click-triggered 3D view. It expands into a rotating, shaded Ψ mesh at 24 fps and exits on click or Escape without changing the prompt. `/logo` supplies a keyboard alternative. Stop its timer completely on close and exit. No animation plays on startup. Streamed output is coalesced into approximately 35ms render windows. UI retains at most 100 transcript components while session evidence remains on disk.

## Assets

`assets/psi.svg` is the standalone vector mark. `assets/psi-wordmark.svg` pairs the same mark with the Psi name.
