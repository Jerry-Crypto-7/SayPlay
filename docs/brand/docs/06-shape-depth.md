# 06 · Shape, borders, shadows & tilt

## Borders
| Token | Width | Use |
|---|---|---|
| `border-thin` | 2px | Chips, small buttons, avatars in lists, step markers |
| `border-base` | 2.5px | Default for every interactive surface |
| `border-thick` | 3px | Sheet top edge, HUD over very busy worlds, app icon art |

Always `--sp-outline` (ink). Error state switches the border to `alarm`.

## Radius — bigger objects, bigger radius
| Token | px | Use |
|---|---|---|
| `xs` | 8 | Code/inline tags |
| `sm` | 12 | Headline highlight, small tiles |
| `md` | 16 | M buttons, stats, objective line |
| `lg` | 20 | L buttons, cards, idea cards |
| `xl` | 24 | Prompt bubble, tab bar |
| `2xl` | 32 | Bottom sheets, desktop dialogs |
| `pill` | 999 | Chips, S buttons, icon buttons, HUD pills, status |

## Hard shadows
| Token | Value | Use |
|---|---|---|
| `shadow-sm` | `3px 3px 0 0 ink` | 44–52px controls, HUD, toasts |
| `shadow-md` | `5px 5px 0 0 ink` | L buttons, prompt bubble |
| `shadow-lg` | `7px 7px 0 0 ink` | Focused prompt, desktop dialog |

Never blur, never tint, never stack shadows.

## Press interaction (the signature)
```css
.sp-btn:active { transform: translate(5px, 5px); box-shadow: none; } /* shadow-md */
.sp-btn--m:active { transform: translate(3px, 3px); }               /* shadow-sm */
```
Duration `press` 90ms, `ease-standard`. On native apps: same offset + light haptic (iOS `.light` impact, Android `KEYBOARD_TAP`).

## Tilt
Allowed only on:
- Idea cards: alternate `−1.5°` / `+1.5°` (`.sp-tilt-l`, `.sp-tilt-r`). Straighten to 0° on press.
- World tags in game: `−4°`.
- Celebration badge on win screen: `−6°`.
- Headline highlight word: `−2°`.

Never tilt buttons, inputs, tab bar, sheets, text blocks or the logo.
