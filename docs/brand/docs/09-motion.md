# 09 · Motion

| Token | ms | Use |
|---|---|---|
| `duration-press` | 90 | Button sink, toggles, chip select |
| `duration-quick` | 160 | Hover, focus lift, idea card straighten |
| `duration-base` | 240 | Sheets, toasts, screen transitions |
| `duration-celebrate` | 420 | Item collected, win badge, stars |

| Easing | Value | Use |
|---|---|---|
| `ease-standard` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Default |
| `ease-pop` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Rewards and idea cards only (overshoot) |
| `ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Things leaving the screen |

## Principles
- Motion answers an action. Nothing moves on its own except the status dot pulse and the generation step pulse.
- One celebration per moment. Win = badge pops in, then stats fade up 60ms apart. No confetti rain loops.
- Screen transitions: new screen slides 24px + fades in 240ms. Game start: 3-2-1 is not used; the world fades in and the objective line pops.
- `prefers-reduced-motion: reduce` → all durations 0, pulses stop, no screen shake (already handled in `tokens.css` and `sayplay.css`).
