# 12 · Accessibility

Target: WCAG 2.2 AA.

## Contrast (measured)
| Pair | Ratio | Use |
|---|---|---|
| ink on cream | 15.7:1 | All text |
| ink on paper | 17.2:1 | All text |
| ink-soft on cream | 7.0:1 | Secondary text |
| ink-faint on paper | 5.7:1 | Placeholder |
| ink on tomato | 5.6:1 | Primary button label |
| ink on sun | 10.9:1 | Labels on sun |
| ink on mint / sky / bubblegum | 10.6–11.5:1 | Idea cards |
| alarm on paper | 5.7:1 | Errors |
| grass on cream | 4.9:1 | Success |
| cream on ink | 15.7:1 | Active tab, status pill |

**Forbidden:** white/cream on tomato (3.1:1), tomato or sun as text colour, any text on `*-deep` shades.

## Interaction
- Touch targets ≥ 44×44 (HUD ≥ 50). Spacing between targets ≥ 8px.
- Focus: `:focus-visible` = 3px ink outline, 3px offset + 7px sun halo. Never remove it.
- Every icon-only control has `aria-label`. Decorative SVG gets `aria-hidden="true"`.
- The prompt has a visible `<label>`. Errors are linked with `aria-describedby` and announced (`aria-live="polite"`).
- Generation steps: container `role="status"`, announce each completed step.
- Game: all actions reachable by keyboard; provide "Tap to move" and on-screen joystick alternatives; subtitles for any voice lines; a "Reduce motion" and "Mute" toggle in pause.
- Colour is never the only signal: threat tags have text ("Dog!"), collected items change from dashed to filled.
- Respect `prefers-reduced-motion` (handled) and support text zoom to 200% without clipping (use rem in app code if needed; tokens are px for design parity).
