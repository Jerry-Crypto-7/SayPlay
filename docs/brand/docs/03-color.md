# 03 · Colour

Source of truth: `tokens/tokens.json`. Use semantic CSS variables (`--sp-primary`, `--sp-text`…) in components; raw palette variables (`--sp-color-tomato`) only in illustrations. **The palette contains no purple or violet.**

## Core
| Token | Hex | Role |
|---|---|---|
| `cream` | `#FFF3DF` | App background |
| `paper` | `#FFFFFF` | Inputs, cards, sheets, HUD pills |
| `ink` | `#1F1A17` | Text, outlines, shadows, icons |
| `tomato` | `#FF5A36` | Primary action, brand accent, in-game threats |
| `sun` | `#FFC530` | Secondary accent: mic, timer, rewards, current step |

## Supporting
| Token | Hex | Role |
|---|---|---|
| `ink-soft` | `#5A524B` | Secondary text |
| `ink-faint` | `#6E655D` | Placeholder, disabled label |
| `cream-deep` | `#FFE7C2` | Hover/pressed fill on cream, disabled button fill |
| `sun-soft` | `#FFD66B` | Idea card (sun variant) |
| `mint` | `#9BE3B0` | Idea card, success surface, "done" step |
| `sky` | `#8FD3FF` | Idea card, info surface, default game sky |
| `bubblegum` | `#FFB8C8` | Idea card only |
| `alarm` | `#C8231B` | Error text and icons |
| `grass` | `#1E7A43` | Success text and icons |
| `*-deep` (tomato/sun/mint/sky) | | Illustration shading only. **Never behind text.** |

## Semantic aliases (tokens.css)
`--sp-bg` cream · `--sp-surface` paper · `--sp-surface-pressed` cream-deep · `--sp-text` ink · `--sp-text-secondary` ink-soft · `--sp-text-placeholder` ink-faint · `--sp-outline` ink · `--sp-primary` tomato · `--sp-on-primary` ink · `--sp-secondary` sun · `--sp-on-secondary` ink · `--sp-danger` alarm · `--sp-success` grass · `--sp-focus` ink

## Proportions (typical screen)
Cream ~58% · Paper ~20% · Ink ~12% · Tomato ~6% · Sun ~4%. If tomato covers more than one element, something is wrong.

## Rules
- Text on any coloured fill = **ink**. Never white/cream on tomato or sun.
- Tomato and sun are **fills**, never text colours.
- Idea cards rotate through mint → sun-soft → sky → bubblegum, in that order.
- Game worlds are generated and can be any colour. UI over them uses opaque paper/sun + ink outlines (see `08-game-hud.md`).
- Dark mode: the product UI stays light (cream). Only full-screen video/share previews may use ink backgrounds with `logo-lockup-on-dark`.

Contrast values: see `12-accessibility.md`.
