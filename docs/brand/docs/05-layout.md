# 05 · Layout, spacing & breakpoints

## Spacing (4px base)
`space-0.5` 2 · `1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 20 · `6` 24 · `8` 32 · `10` 40 · `12` 48 · `16` 64 · `20` 80

- Screen side margin: **20px** mobile, **32px** tablet, **48px** desktop.
- Between groups on a screen: **24px**. Inside a group: **12px**. Inside a component: **8–16px**.
- Bottom of scroll content: tab bar height + 16 + safe-area + 16.

## Breakpoints
| Name | Range | Layout |
|---|---|---|
| `sm` | 0–599 | Single column, floating tab bar, bottom sheets |
| `md` | 600–1023 | Single column centred, max content 560px, idea grid 3 cols |
| `lg` | 1024–1439 | Left rail (240px) replaces tab bar, 12-col grid, 24 gutters, content max 1200 |
| `xl` | 1440+ | Same as lg, more whitespace; game stage max 1280×720 |

## Mobile home (390 reference)
```
appbar 62 (logo 30h, avatar 44)
headline display-l               ← 26px below appbar
prompt bubble                    ← 24px
primary button 62                ← 18px
"Need an idea?" + idea grid 2×2  ← 26px, gap 12
floating tab bar 66              ← 12px from sides, 16px + safe area from bottom
```

## Desktop
- Left rail 240px: logo, then nav items (same active style as tab bar: ink pill, cream text).
- Home: headline + prompt (max 640px) on the left, a live preview of a featured game (16:9) on the right.
- Sheets become centred dialogs (max 520px wide, 2xl radius on all corners, same border/shadow-lg).
- Game: 16:9 stage centred, max 1280×720; the HUD is positioned relative to the stage, not the window. Letterbox with cream.
- Hover: shadow grows sm→md (or md→lg) with a −1px/−1px lift. Press still sinks. Cursor pointer only on interactive elements.
- Keyboard: Enter = submit prompt (Shift+Enter newline), Space = pause, R = restart, Esc = close sheet / exit game, M = mute.

## Safe areas
Always pad with `env(safe-area-inset-*)`: top of HUD, tab bar, bottom sheets, toasts. Add `viewport-fit=cover` to the viewport meta.
