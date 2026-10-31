# Psi terminal design

## Context and theme

A developer works for hours in their existing terminal, often through long evening benchmark sessions. Psi inherits that terminal's background and font, preserving its configured ambient-light contrast and text size.

## Color

Restrained. The default sage accent, `oklch(68% 0.105 162)`, identifies Ψ, active selections and links. `/settings` offers five other restrained presets and custom hex/OKLCH colours; changes update the interface and logo immediately. Default foreground supplies body text; terminal dim supplies secondary text. Red always accompanies a written failure label. No background fill or gradient.

## Typography

Use the terminal's configured monospace font. Bold distinguishes product and picker titles. A compact, shaded Ψ mark (12 columns by 4 rows), rendered from a small extruded mesh, brands the workspace. Keep the nearby Psi wordmark and workspace path compact. Omit startup marketing/help copy.

## Layout

A fullscreen terminal viewport contains the workspace header, a scrolling conversation and inline selection panel. The multiline prompt is pinned to the bottom on startup, during output and through resizes. The first row below it shows the model on the left and thinking level aligned to the right, with no provider label. A second row shows the active account name. Subscription accounts display only reported usage windows (5h/7d when supplied), omitting absent/unlimited windows. Metered API accounts display the current session cost, or cost unavailable when pricing is unknown. Add one compact bottom row for estimated plan completion and the PLAN/EXECUTE mode. Mark the percentage as an estimate. Conversation scrolling and selection use the terminal renderer; the visible document returns to shell scrollback on exit. Pickers filter immediately and expose keyboard hints. Narrow widths truncate metadata before primary actions. Tool results show short previews, with full results in session artifacts.

## Interaction

Shift+Tab toggles PLAN/EXECUTE. Tab inside /effort toggles OVERKILL. Slash commands and Tab completion; Enter submits; Shift+Enter adds a line; Escape closes a picker; two Escapes within 600 ms stop a run; Ctrl+C cancels a prompt or active run and exits when idle. Pickers support arrow keys and text search. Settings use a searchable list with values and short explanations, then a focused picker or input for the chosen setting. Hide the workspace logo while a picker is open to preserve space. Appearance updates immediately; execution settings queue until the next safe boundary. The logo alone has an explicitly requested, click-triggered 3D view. It opens a rotating, shaded Ψ mesh occupying at most half the terminal height and 52 columns, at 24 fps and exits on click or Escape without changing the prompt. `/logo` supplies a keyboard alternative. Stop its timer completely on close and exit. No animation plays on startup. Streamed output is coalesced into approximately 35ms render windows. UI retains at most 100 transcript components while session evidence remains on disk.

## Assets

`assets/psi.svg` is the standalone vector mark. `assets/psi-wordmark.svg` pairs the same mark with the Psi name.
